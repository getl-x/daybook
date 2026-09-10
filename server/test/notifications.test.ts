/**
 * 提醒领域与调度器的测试：纯逻辑 + 用内存 store/假 sender 跑调度器。
 *
 * 关注三件事：幂等（重试不重复打扰）、"仅未完成时提醒"、订阅失效（410）处理。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AppStore } from '../src/app.ts';
import {
  computeNextFire,
  normalizeLocalTime,
  previousDiaryDate,
  reminderLocalDate,
  reminderPayload,
  shouldSkipForCompletion,
  type NotificationStore,
  type PushSubscriptionRecord,
  type ReminderSettings,
} from '../src/notifications.ts';
import type { PushPayload, PushResult, PushSender } from '../src/push.ts';
import { runDueReminders, rescheduleUser } from '../src/scheduler.ts';
import { createFakeStore, type FakeStore } from './helpers/fake-store.ts';

/** 上海时间 2026-09-10 09:00 */
const FIRE_AT = new Date('2026-09-10T01:00:00Z');
const NEXT_DAY_FIRE_AT = '2026-09-11T01:00:00.000Z';

const BASE_SETTINGS: ReminderSettings = {
  timezone: 'Asia/Shanghai',
  dayStartHour: 4,
  morningReminderEnabled: true,
  morningReminderTime: '09:00',
  eveningReminderEnabled: true,
  eveningReminderTime: '21:00',
  notifyOnlyIfIncomplete: true,
};

interface SenderHarness {
  sender: PushSender;
  sent: { endpoint: string; payload: PushPayload }[];
}

function createFakeSender(outcome: (subscription: PushSubscriptionRecord) => PushResult): SenderHarness {
  const sent: { endpoint: string; payload: PushPayload }[] = [];
  return {
    sent,
    sender: {
      async send(subscription, payload) {
        sent.push({ endpoint: subscription.endpoint, payload });
        return outcome(subscription);
      },
    },
  };
}

function makeDeps(store: FakeStore, sender: PushSender | null, now: Date) {
  const logs: string[] = [];
  return {
    deps: {
      store: store as AppStore & NotificationStore,
      sender,
      now: () => now,
      log: (level: 'info' | 'warn' | 'error', message: string) => logs.push(`${level}:${message}`),
    },
    logs,
  };
}

function addSubscription(store: FakeStore, userId: string, endpoint: string): PushSubscriptionRecord {
  const created: PushSubscriptionRecord & { userId: string } = {
    id: `sub-${endpoint}`,
    userId,
    endpoint,
    p256dh: 'p256dh-key',
    auth: 'auth-key',
    userAgent: 'test-agent',
    disabledAt: null,
    failureCount: 0,
    createdAt: new Date(),
  };
  store.pushSubscriptions.set(created.id, created);
  return created;
}

describe('提醒设置与时刻计算（纯逻辑）', () => {
  it('normalizeLocalTime 只接受 HH:MM', () => {
    assert.equal(normalizeLocalTime('09:00', 'x'), '09:00');
    assert.equal(normalizeLocalTime('23:59', 'x'), '23:59');
    for (const bad of ['9:00', '24:00', '09:60', '', undefined, 900]) {
      assert.throws(() => normalizeLocalTime(bad, 'x'), /HH:MM|不是合法时间/);
    }
  });

  it('computeNextFire：开启时按用户时区算，关闭时返回 null', () => {
    const next = computeNextFire(BASE_SETTINGS, 'morning', new Date('2026-09-09T20:00:00Z'));
    assert.equal(next?.toISOString(), FIRE_AT.toISOString());

    const disabled = computeNextFire({ ...BASE_SETTINGS, morningReminderEnabled: false }, 'morning', new Date());
    assert.equal(disabled, null);
  });

  it('computeNextFire：改时间立刻反映到下一次触发', () => {
    const next = computeNextFire({ ...BASE_SETTINGS, eveningReminderTime: '22:30' }, 'evening', FIRE_AT);
    assert.equal(next?.toISOString(), '2026-09-10T14:30:00.000Z'); // 上海 22:30
  });

  it('reminderLocalDate：09:00 属于当天日记日（日界 04:00 之后）', () => {
    assert.equal(reminderLocalDate('morning', FIRE_AT, BASE_SETTINGS), '2026-09-10');
    assert.equal(previousDiaryDate('2026-09-10'), '2026-09-09');
  });

  it('shouldSkipForCompletion：早间要"昨天回顾 + 今天计划"都写了才跳过；晚间只看总结', () => {
    const entry = (values: Record<string, string>): { fields: Record<string, { value: string | null }> } => ({
      fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])),
    });

    const today = entry({ day_plan: '写日记' });
    const yesterday = entry({ day_events: '开了会' });
    assert.equal(shouldSkipForCompletion('morning', today, yesterday), true);
    assert.equal(shouldSkipForCompletion('morning', entry({}), yesterday), false);
    assert.equal(shouldSkipForCompletion('morning', today, entry({})), false);
    assert.equal(shouldSkipForCompletion('morning', today, entry({ day_plan: '   ' })), false);

    assert.equal(shouldSkipForCompletion('evening', entry({ evening_summary: '还行' }), null), true);
    assert.equal(shouldSkipForCompletion('evening', today, null), false);
    assert.equal(shouldSkipForCompletion('evening', null, null), false);
  });

  it('提醒文案不含正文，只带引导与深链', () => {
    const morning = reminderPayload('morning');
    assert.equal(morning.url, '/#/today');
    assert.equal(morning.title, '早上好');
    assert.ok(morning.body.includes('回顾昨天'));
    const evening = reminderPayload('evening');
    assert.ok(evening.body.includes('总结'));
    assert.notEqual(morning.tag, evening.tag);
  });
});

describe('调度器（内存 store + 假 sender）', () => {
  it('到点且"仅未完成"满足条件 → 发送一次并推进排程', async () => {
    const store = createFakeStore();
    const user = store.addUser({ username: 'getl', passwordHash: 'x' });
    await store.updateReminderSettings(user.id, {}); // 落到默认值
    store.seedSchedule(user.id, 'morning', FIRE_AT);
    addSubscription(store, user.id, 'https://push.example/1');
    // 昨天没写、今天也没写 → 不该跳过
    const { sender, sent } = createFakeSender(() => ({ status: 'sent' }));
    const { deps } = makeDeps(store, sender, FIRE_AT);

    const report = await runDueReminders(deps, FIRE_AT);

    assert.equal(report.due, 1);
    assert.equal(report.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.payload.title, '早上好');
    assert.equal(store.schedules.get(`${user.id}:morning`)?.toISOString(), NEXT_DAY_FIRE_AT);
    assert.equal(store.deliveries.get(`${user.id}:2026-09-10:morning`)?.status, 'sent');
  });

  it('内容已完成 + 仅未完成时提醒 → 记 skipped，不发推送', async () => {
    const store = createFakeStore();
    const user = store.addUser({ username: 'getl', passwordHash: 'x' });
    await store.updateReminderSettings(user.id, {});
    store.seedSchedule(user.id, 'morning', FIRE_AT);
    addSubscription(store, user.id, 'https://push.example/1');
    // 昨天回顾 + 今天计划都写了
    store.seedEntry(user.id, {
      entryDate: '2026-09-09',
      exists: true,
      version: 1,
      fields: {
        day_events: { value: '开了会', updatedAt: null },
        day_meals: { value: null, updatedAt: null },
        day_plan: { value: null, updatedAt: null },
        evening_summary: { value: null, updatedAt: null },
      },
    });
    store.seedEntry(user.id, {
      entryDate: '2026-09-10',
      exists: true,
      version: 1,
      fields: {
        day_events: { value: null, updatedAt: null },
        day_meals: { value: null, updatedAt: null },
        day_plan: { value: '写日记', updatedAt: null },
        evening_summary: { value: null, updatedAt: null },
      },
    });

    const { sender, sent } = createFakeSender(() => ({ status: 'sent' }));
    const { deps } = makeDeps(store, sender, FIRE_AT);
    const report = await runDueReminders(deps, FIRE_AT);

    assert.equal(report.skipped, 1);
    assert.equal(sent.length, 0);
    assert.equal(store.deliveries.get(`${user.id}:2026-09-10:morning`)?.status, 'skipped');
    assert.equal(store.schedules.get(`${user.id}:morning`)?.toISOString(), NEXT_DAY_FIRE_AT);
  });

  it('关闭"仅未完成时提醒"后，即使写完了也照发', async () => {
    const store = createFakeStore();
    const user = store.addUser({ username: 'getl', passwordHash: 'x' });
    await store.updateReminderSettings(user.id, { notifyOnlyIfIncomplete: false });
    store.seedSchedule(user.id, 'evening', FIRE_AT);
    addSubscription(store, user.id, 'https://push.example/1');
    const { sender, sent } = createFakeSender(() => ({ status: 'sent' }));
    const { deps } = makeDeps(store, sender, FIRE_AT);

    const report = await runDueReminders(deps, FIRE_AT);
    assert.equal(report.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.payload.tag, 'daybook-evening');
  });

  it('410（订阅失效）→ 立即禁用该订阅，且不重试', async () => {
    const store = createFakeStore();
    const user = store.addUser({ username: 'getl', passwordHash: 'x' });
    await store.updateReminderSettings(user.id, { notifyOnlyIfIncomplete: false });
    store.seedSchedule(user.id, 'morning', FIRE_AT);
    const subscription = addSubscription(store, user.id, 'https://push.example/gone');

    const { sender } = createFakeSender(() => ({ status: 'gone', error: 'HTTP 410' }));
    const { deps } = makeDeps(store, sender, FIRE_AT);
    const report = await runDueReminders(deps, FIRE_AT);

    assert.equal(report.disabledSubscriptions, 1);
    assert.equal(report.failed, 1);
    assert.ok(store.pushSubscriptions.get(subscription.id)?.disabledAt instanceof Date);
    assert.equal(store.pushSubscriptions.get(subscription.id)?.failureCount, 1);
    // 没有可用订阅了，但仍然推进排程（避免卡死在当天）
    assert.equal(store.schedules.get(`${user.id}:morning`)?.toISOString(), NEXT_DAY_FIRE_AT);
  });

  it('暂时性失败 → 不推进排程，下一轮重试（最多 3 次）', async () => {
    const store = createFakeStore();
    const user = store.addUser({ username: 'getl', passwordHash: 'x' });
    await store.updateReminderSettings(user.id, { notifyOnlyIfIncomplete: false });
    store.seedSchedule(user.id, 'morning', FIRE_AT);
    addSubscription(store, user.id, 'https://push.example/1');

    const { sender, sent } = createFakeSender(() => ({ status: 'failed', error: 'HTTP 500' }));
    const { deps } = makeDeps(store, sender, FIRE_AT);

    // 第 1 次：失败 → 排程不动
    await runDueReminders(deps, FIRE_AT);
    assert.equal(store.deliveries.get(`${user.id}:2026-09-10:morning`)?.attempts, 1);
    assert.equal(store.schedules.get(`${user.id}:morning`)?.toISOString(), FIRE_AT.toISOString());

    // 第 2、3 次：继续重试
    await runDueReminders(deps, FIRE_AT);
    await runDueReminders(deps, FIRE_AT);
    assert.equal(store.deliveries.get(`${user.id}:2026-09-10:morning`)?.attempts, 3);
    assert.equal(sent.length, 3);

    // 第 4 次：超过上限 → 放弃并推进
    const report = await runDueReminders(deps, FIRE_AT);
    assert.equal(report.failed, 0);
    assert.equal(report.replayed, 1);
    assert.equal(store.schedules.get(`${user.id}:morning`)?.toISOString(), NEXT_DAY_FIRE_AT);
    assert.equal(sent.length, 3, '第 4 次不该再发');
  });

  it('幂等：已发送过的排程再次到期不会重复打扰', async () => {
    const store = createFakeStore();
    const user = store.addUser({ username: 'getl', passwordHash: 'x' });
    await store.updateReminderSettings(user.id, { notifyOnlyIfIncomplete: false });
    store.seedSchedule(user.id, 'morning', FIRE_AT);
    addSubscription(store, user.id, 'https://push.example/1');
    // 模拟"上一轮已经发过，但排程因为崩溃没推进"
    store.deliveries.set(`${user.id}:2026-09-10:morning`, { status: 'sent', attempts: 1, lastError: null });

    const { sender, sent } = createFakeSender(() => ({ status: 'sent' }));
    const { deps } = makeDeps(store, sender, FIRE_AT);
    const report = await runDueReminders(deps, FIRE_AT);

    assert.equal(report.replayed, 1);
    assert.equal(sent.length, 0, '不该重复发');
    assert.equal(store.schedules.get(`${user.id}:morning`)?.toISOString(), NEXT_DAY_FIRE_AT);
  });

  it('没配 VAPID（sender 为 null）→ 记失败并推进，不卡死', async () => {
    const store = createFakeStore();
    const user = store.addUser({ username: 'getl', passwordHash: 'x' });
    await store.updateReminderSettings(user.id, { notifyOnlyIfIncomplete: false });
    store.seedSchedule(user.id, 'morning', FIRE_AT);
    addSubscription(store, user.id, 'https://push.example/1');

    const { deps } = makeDeps(store, null, FIRE_AT);
    const report = await runDueReminders(deps, FIRE_AT);

    assert.equal(report.failed, 1);
    assert.equal(store.deliveries.get(`${user.id}:2026-09-10:morning`)?.status, 'failed');
    assert.equal(store.schedules.get(`${user.id}:morning`)?.toISOString(), NEXT_DAY_FIRE_AT);
  });

  it('rescheduleUser 会按设置重建两种提醒的排程', async () => {
    const store = createFakeStore();
    const user = store.addUser({ username: 'getl', passwordHash: 'x' });
    await store.updateReminderSettings(user.id, { morningReminderTime: '07:30', eveningReminderEnabled: false });

    await rescheduleUser(store, user.id, FIRE_AT);

    // now 是上海 09:00，当天的 07:30 已经过了 → 下一次是第二天 07:30（上海）= 09-10T23:30Z
    assert.equal(store.schedules.get(`${user.id}:morning`)?.toISOString(), '2026-09-10T23:30:00.000Z');
    assert.equal(store.schedules.get(`${user.id}:evening`), null);
  });
});
