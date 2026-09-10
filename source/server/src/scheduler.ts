/**
 * 提醒调度器：每分钟跑一次（进程内 setInterval）。
 *
 * 流程（计划 §8.2）：
 *   取到期排程 → 幂等占位 notification_deliveries → "仅未完成时提醒"判定
 *   → 给该用户所有有效订阅发送 → 更新订阅失败计数/禁用 → 重算下一次触发时刻
 *
 * 重试：失败时**不**推进排程，下一 tick 自然重试；attempts ≥ 3 才放弃并推进。
 * 幂等：唯一键 (user_id, local_date, kind) 保证重试/多进程都不会重复打扰。
 *
 * 韧性：每个用户单独 try/catch。某个账号的脏数据（例如手工改坏的时区）不能让整个 tick
 * 中断——否则那一行会一直 due，把其他所有人的提醒也一起拖死。
 */
import type { AppStore } from './app.ts';
import {
  computeNextFire,
  previousDiaryDate,
  reminderLocalDate,
  reminderPayload,
  shouldSkipForCompletion,
  type NotificationStore,
  type ReminderKind,
  type ReminderSettings,
} from './notifications.ts';
import type { PushSender } from './push.ts';

const MAX_ATTEMPTS = 3;
const DUE_BATCH = 200;

export interface SchedulerDeps {
  store: AppStore & NotificationStore;
  /** 没配 VAPID 时为 null：此时只记录失败，不发请求 */
  sender: PushSender | null;
  now(): Date;
  log(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void;
  /** 顺手清理过了宽限期的待删除账号（可选，由 index.ts 接到 users.purgeExpiredAccounts） */
  purgeExpiredAccounts?(): Promise<number>;
}

export interface SchedulerReport {
  due: number;
  sent: number;
  skipped: number;
  failed: number;
  replayed: number;
  disabledSubscriptions: number;
  /** 处理某条排程时抛异常的次数（脏数据/数据库抖动），不影响其他用户 */
  errors: number;
}

/** 按当前设置重算某个用户两种提醒的下一次触发时刻（改时间/改时区/开关后调用） */
export async function rescheduleUser(
  store: Pick<NotificationStore, 'getReminderSettings' | 'setSchedule'>,
  userId: string,
  now: Date,
): Promise<ReminderSettings> {
  const settings = await store.getReminderSettings(userId);
  for (const kind of ['morning', 'evening'] as const) {
    await store.setSchedule(userId, kind, computeNextFire(settings, kind, now));
  }
  return settings;
}

export async function runDueReminders(deps: SchedulerDeps, now: Date = deps.now()): Promise<SchedulerReport> {
  const report: SchedulerReport = {
    due: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    replayed: 0,
    disabledSubscriptions: 0,
    errors: 0,
  };

  // 账号删除的宽限期清理：搭在每分钟的 tick 上，不需要单独的定时任务
  if (deps.purgeExpiredAccounts) {
    try {
      const purged = await deps.purgeExpiredAccounts();
      if (purged > 0) deps.log('info', '已清除宽限期到期的账号', { purged });
    } catch (error) {
      report.errors += 1;
      deps.log('error', '清理待删除账号失败', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const due = await deps.store.listDueSchedules(now, DUE_BATCH);
  report.due = due.length;

  for (const schedule of due) {
    try {
      await processSchedule(deps, schedule.userId, schedule.kind, schedule.nextFireAt, now, report);
    } catch (error) {
      report.errors += 1;
      deps.log('error', '处理这条提醒排程时出错，已跳过（下一分钟再试）', {
        userId: schedule.userId,
        kind: schedule.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

async function processSchedule(
  deps: SchedulerDeps,
  userId: string,
  kind: ReminderKind,
  nextFireAt: Date,
  now: Date,
  report: SchedulerReport,
): Promise<void> {
  const user = await deps.store.findUserById(userId);
  if (!user || user.status !== 'active') {
    // 停用 / 待删除账号不该继续收到提醒：直接停掉排程（不做推进计算）
    await deps.store.setSchedule(userId, kind, null);
    return;
  }

  const settings = await deps.store.getReminderSettings(userId);
  const localDate = reminderLocalDate(kind, nextFireAt, settings);

  // 1) 幂等占位：重复 tick、重启、多进程都只会产生一条记录
  const firstTime = await deps.store.beginDelivery(userId, localDate, kind);
  if (!firstTime) {
    const existing = await deps.store.getDelivery(userId, localDate, kind);
    const finished = existing === null || existing.status === 'sent' || existing.status === 'skipped';
    if (finished || existing.attempts >= MAX_ATTEMPTS) {
      report.replayed += 1;
      await advance(deps, userId, settings, kind, localDate, report, now);
      return;
    }
    deps.log('info', '重试上一次失败的提醒', { userId, kind, attempts: existing.attempts });
  }

  // 2) 仅未完成时提醒：发送前再查一次内容（和今日页进度同一套派生规则）
  if (settings.notifyOnlyIfIncomplete) {
    const today = await deps.store.getDiaryEntry(userId, localDate);
    const yesterday = await deps.store.getDiaryEntry(userId, previousDiaryDate(localDate));
    if (shouldSkipForCompletion(kind, today, yesterday)) {
      await deps.store.finishDelivery(userId, localDate, kind, 'skipped');
      report.skipped += 1;
      await advance(deps, userId, settings, kind, localDate, report, now);
      return;
    }
  }

  // 3) 发送
  const subscriptions = await deps.store.listPushSubscriptions(userId);
  if (!deps.sender || subscriptions.length === 0) {
    const reason = deps.sender ? '没有可用的推送订阅' : '未配置 VAPID 密钥';
    await deps.store.finishDelivery(userId, localDate, kind, 'failed', reason);
    report.failed += 1;
    deps.log('warn', '提醒没有发出：' + reason, { userId, kind });
    // 配置问题重试也没用 → 直接推进到下一个周期
    await advance(deps, userId, settings, kind, localDate, report, now);
    return;
  }

  const payload = reminderPayload(kind);
  let delivered = 0;
  let failedHere = 0;
  let goneHere = 0;
  for (const subscription of subscriptions) {
    const result = await deps.sender.send(subscription, payload);
    await deps.store.recordPushResult(subscription.id, result.status, now);
    if (result.status === 'sent') delivered += 1;
    else if (result.status === 'gone') goneHere += 1;
    else failedHere += 1;
  }
  report.disabledSubscriptions += goneHere;

  if (delivered > 0) {
    await deps.store.finishDelivery(userId, localDate, kind, 'sent');
    report.sent += 1;
    deps.log('info', '提醒已发送', { userId, kind, delivered, gone: goneHere });
    await advance(deps, userId, settings, kind, localDate, report, now);
    return;
  }

  // 全部失败：通常留在队列里等下一 tick 重试（attempts 到上限后自然推进）；
  // 但如果已经没有任何可用订阅（都在刚才被判失效了），重试没有意义 → 直接推进
  const remaining = await deps.store.listPushSubscriptions(userId);
  await deps.store.finishDelivery(
    userId,
    localDate,
    kind,
    'failed',
    `${failedHere} 个订阅发送失败，${goneHere} 个已失效`,
  );
  report.failed += 1;
  deps.log('warn', '提醒发送失败，稍后重试', { userId, kind, failedHere, goneHere });
  if (remaining.length === 0) {
    await advance(deps, userId, settings, kind, localDate, report, now);
  }
}

/** 推进到下一个触发时刻（严格大于 tick 的时间） */
async function advance(
  deps: SchedulerDeps,
  userId: string,
  settings: ReminderSettings,
  kind: ReminderKind,
  localDate: string,
  report: SchedulerReport,
  now: Date,
): Promise<void> {
  const next = computeNextFire(settings, kind, now);
  await deps.store.setSchedule(userId, kind, next);
  // 带上刚处理过的日记日与累计计数：排查"为什么没收到提醒"时，这条日志最有用
  deps.log('info', '排程已推进', {
    userId,
    kind,
    handledLocalDate: localDate,
    nextFireAt: next?.toISOString() ?? null,
    sentSoFar: report.sent,
    skippedSoFar: report.skipped,
    failedSoFar: report.failed,
  });
}
