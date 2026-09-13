/**
 * 提醒与推送订阅的领域逻辑（纯函数 + 类型；SQL 实现在 src/db/store.ts）。
 *
 * 三条不变式：
 *  1. 下一次触发时刻一律由 shared/src/time.ts 的 nextFireAt 算（时区 + 日界 + DST 都覆盖）；
 *  2. 幂等键是 (user_id, 日记日, 类型)——任务重试不会重复打扰；
 *  3. "仅未完成时提醒"在发送前再查一次内容，避免无意义打扰。
 */
import { addDays, nextFireAt, type ISODate } from '@daybook/shared';

import type { ServerSettings } from './diary.ts';
import { DiaryError } from './diary.ts';
import { diaryDate } from '@daybook/shared';
import type { QuietHours } from './quiet-hours.ts';

export type ReminderKind = 'morning' | 'evening';
export const REMINDER_KINDS: readonly ReminderKind[] = ['morning', 'evening'];

/** 订阅平台白名单：客户端用 describeCurrentDevice() 推断（web / ios-pwa / android） */
export const SUBSCRIPTION_PLATFORMS = ['web', 'ios-pwa', 'android'] as const;
export type SubscriptionPlatform = (typeof SUBSCRIPTION_PLATFORMS)[number];

/** 设备名最长长度（超长截断，避免脏数据把列表撑爆） */
export const SUBSCRIPTION_LABEL_MAX = 40;

export function isSubscriptionPlatform(value: unknown): value is SubscriptionPlatform {
  return typeof value === 'string' && (SUBSCRIPTION_PLATFORMS as readonly string[]).includes(value);
}

export interface ReminderSettings extends ServerSettings {
  morningReminderEnabled: boolean;
  morningReminderTime: string;
  eveningReminderEnabled: boolean;
  eveningReminderTime: string;
  notifyOnlyIfIncomplete: boolean;
  /** 静默时段：落在窗口内的提醒推迟到窗口结束（见 src/quiet-hours.ts） */
  quietHours: QuietHours;
}

export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  disabledAt: Date | null;
  /** 设备名（客户端按 UA 推断，可空） */
  label: string | null;
  /** 平台：web / ios-pwa / android（可空） */
  platform: string | null;
  failureCount: number;
  createdAt: Date;
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
  label?: string | null;
  platform?: string | null;
}

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface DueSchedule {
  userId: string;
  kind: ReminderKind;
  nextFireAt: Date;
}

/** 'HH:MM' → 校验；错误直接抛（入库前拦住脏数据） */
export function normalizeLocalTime(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !/^\d{2}:\d{2}$/.test(raw)) {
    throw new DiaryError('invalid_field', `${field} 必须是 HH:MM 格式`);
  }
  const [hour, minute] = raw.split(':').map(Number);
  if (hour === undefined || minute === undefined || hour > 23 || minute > 59) {
    throw new DiaryError('invalid_field', `${field} 不是合法时间：${raw}`);
  }
  return raw;
}

export function isReminderKind(value: string): value is ReminderKind {
  return (REMINDER_KINDS as readonly string[]).includes(value);
}

/** 这一次提醒对应的日记日（09:00/21:00 都落在当天日记日内；凌晨的提醒会归前一天，与本模型一致） */
export function reminderLocalDate(kind: ReminderKind, fireAt: Date, settings: ReminderSettings): ISODate {
  void kind; // 两种提醒的触发时刻都在当天日记日的 04:00 之后，归属日相同；保留参数以便将来支持自定义时间
  return diaryDate(fireAt, settings.timezone, settings.dayStartHour);
}

export function reminderTime(settings: ReminderSettings, kind: ReminderKind): string {
  return kind === 'morning' ? settings.morningReminderTime : settings.eveningReminderTime;
}

export function reminderEnabled(settings: ReminderSettings, kind: ReminderKind): boolean {
  return kind === 'morning' ? settings.morningReminderEnabled : settings.eveningReminderEnabled;
}

/** 下一次触发时刻；关闭了返回 null（排程行会写 null） */
export function computeNextFire(
  settings: ReminderSettings,
  kind: ReminderKind,
  now: Date,
): Date | null {
  if (!reminderEnabled(settings, kind)) return null;
  return nextFireAt(now, settings.timezone, reminderTime(settings, kind), settings.dayStartHour);
}

/**
 * "仅未完成时提醒" 的判断：早间看【今天的计划】，晚间看【今天的总结】。
 * 与今日页进度用的是同一套派生规则（不存 completed_at）。
 */
export function shouldSkipForCompletion(
  kind: ReminderKind,
  todayEntry: { fields: Record<string, { value: string | null }> } | null,
): boolean {
  const has = (entry: { fields: Record<string, { value: string | null }> } | null, field: string): boolean => {
    const value = entry?.fields[field]?.value;
    return typeof value === 'string' && value.trim() !== '';
  };

  if (kind === 'morning') {
    return has(todayEntry, 'day_plan');
  }
  return has(todayEntry, 'evening_summary');
}

/** 提醒文案（计划 §7.2：不泄露正文，只做引导） */
export function reminderPayload(kind: ReminderKind): { title: string; body: string; url: string; tag: string } {
  return kind === 'morning'
    ? {
        title: '早上好',
        body: '想想今天都要做什么，写两句就够了。',
        url: '/#/today',
        tag: 'daybook-morning',
      }
    : {
        title: '今天过得怎么样？',
        body: '写几句总结，给今天画上句号。',
        url: '/#/today',
        tag: 'daybook-evening',
      };
}

/** 供日历/日志使用：昨天的日记日 */
export function previousDiaryDate(date: ISODate): ISODate {
  return addDays(date, -1);
}

/* ------------------------------ 存储端口 ------------------------------ */

/** 提醒与推送相关的存储能力（实现在 src/db/notification-store.ts） */
export interface NotificationStore {
  getReminderSettings(userId: string): Promise<ReminderSettings>;
  updateReminderSettings(
    userId: string,
    patch: Partial<{
      timezone: string;
      dayStartHour: number;
      morningReminderEnabled: boolean;
      morningReminderTime: string;
      eveningReminderEnabled: boolean;
      eveningReminderTime: string;
      notifyOnlyIfIncomplete: boolean;
      theme: string;
      quietEnabled: boolean;
      quietStart: string;
      quietEnd: string;
    }>,
  ): Promise<ReminderSettings>;

  /** 排程：每用户每类型一行；null = 关闭 */
  setSchedule(userId: string, kind: ReminderKind, nextFireAt: Date | null): Promise<void>;
  listDueSchedules(now: Date, limit: number): Promise<DueSchedule[]>;

  /** 幂等占位与收尾（唯一键 (user_id, local_date, kind)） */
  beginDelivery(userId: string, localDate: ISODate, kind: ReminderKind): Promise<boolean>;
  getDelivery(
    userId: string,
    localDate: ISODate,
    kind: ReminderKind,
  ): Promise<{ status: DeliveryStatus; attempts: number; lastError: string | null } | null>;
  finishDelivery(
    userId: string,
    localDate: ISODate,
    kind: ReminderKind,
    status: DeliveryStatus,
    error?: string | null,
  ): Promise<void>;
  listReminderDeliveries(
    userId: string,
    limit: number,
  ): Promise<
    { localDate: ISODate; kind: ReminderKind; status: DeliveryStatus; attempts: number; lastError: string | null }[]
  >;

  /** 排程取订阅用：只返回启用的（disabled_at IS NULL） */
  listPushSubscriptions(userId: string): Promise<PushSubscriptionRecord[]>;
  /** 设置页设备列表用：返回全部（含已停用），交由界面显示 enabled 状态 */
  listAllPushSubscriptions(userId: string): Promise<PushSubscriptionRecord[]>;
  upsertPushSubscription(userId: string, input: PushSubscriptionInput): Promise<PushSubscriptionRecord>;
  /** 启用/停用某条订阅（复用 disabled_at）；true = 属于本人且更新成功，false = 不存在或不属于本人 */
  setSubscriptionEnabled(userId: string, id: string, enabled: boolean): Promise<boolean>;
  deletePushSubscription(userId: string, id: string): Promise<boolean>;
  /** 发送结果回写：sent 清计数；gone 直接禁用；failed 累计到阈值后禁用 */
  recordPushResult(id: string, result: 'sent' | 'failed' | 'gone', at: Date): Promise<void>;
}
