/**
 * 提醒与推送相关的存储实现（与 src/db/store.ts 同一个库，单独成文件只为可读）。
 *
 * 与主 store 一样：全部参数化，字段名来自白名单。
 * 设计取舍：取到期排程不用 `FOR UPDATE SKIP LOCKED`——worker 只有一个进程，
 * 真正防重复靠的是 notification_deliveries 上的幂等唯一键（(user_id, local_date, kind)）。
 */
import { randomUUID } from 'node:crypto';

import type {
  DeliveryStatus,
  DueSchedule,
  NotificationStore,
  PushSubscriptionInput,
  PushSubscriptionRecord,
  ReminderKind,
  ReminderSettings,
} from '../notifications.ts';
import type { Db } from './db.ts';

interface SettingsRow {
  timezone: string;
  day_start_hour: number;
  morning_reminder_enabled: boolean;
  morning_time: string;
  evening_reminder_enabled: boolean;
  evening_time: string;
  notify_only_if_incomplete: boolean;
  quiet_enabled: boolean;
  quiet_start: string | null;
  quiet_end: string | null;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  disabled_at: string | Date | null;
  failure_count: number;
  created_at: string | Date;
}

const SUBSCRIPTION_SELECT =
  'id, endpoint, p256dh, auth, user_agent, disabled_at, failure_count, created_at';

const SETTINGS_SELECT = `timezone, day_start_hour,
  morning_reminder_enabled, to_char(morning_reminder_time, 'HH24:MI') AS morning_time,
  evening_reminder_enabled, to_char(evening_reminder_time, 'HH24:MI') AS evening_time,
  notify_only_if_incomplete,
  quiet_enabled, to_char(quiet_start, 'HH24:MI') AS quiet_start, to_char(quiet_end, 'HH24:MI') AS quiet_end`;

function toSettings(row: SettingsRow | undefined): ReminderSettings {
  if (!row) {
    return {
      timezone: 'Asia/Shanghai',
      dayStartHour: 4,
      morningReminderEnabled: true,
      morningReminderTime: '09:00',
      eveningReminderEnabled: true,
      eveningReminderTime: '21:00',
      notifyOnlyIfIncomplete: true,
      quietHours: { enabled: false, start: '', end: '' },
    };
  }
  return {
    timezone: row.timezone,
    dayStartHour: Number(row.day_start_hour),
    morningReminderEnabled: row.morning_reminder_enabled,
    morningReminderTime: row.morning_time,
    eveningReminderEnabled: row.evening_reminder_enabled,
    eveningReminderTime: row.evening_time,
    notifyOnlyIfIncomplete: row.notify_only_if_incomplete,
    quietHours: { enabled: row.quiet_enabled, start: row.quiet_start ?? '', end: row.quiet_end ?? '' },
  };
}

function toSubscription(row: SubscriptionRow): PushSubscriptionRecord {
  return {
    id: row.id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.user_agent,
    disabledAt: row.disabled_at === null ? null : new Date(row.disabled_at),
    failureCount: Number(row.failure_count),
    createdAt: new Date(row.created_at),
  };
}

/** 连续失败多少次就自动禁用（避免给一个坏订阅永远重试） */
const FAILURE_LIMIT = 10;

export function createNotificationStore(db: Db): NotificationStore {
  return {
    async getReminderSettings(userId: string): Promise<ReminderSettings> {
      const { rows } = await db.query<SettingsRow>(
        `SELECT ${SETTINGS_SELECT} FROM user_settings WHERE user_id = $1`,
        [userId],
      );
      return toSettings(rows[0]);
    },

    /** 只更新传进来的字段（白名单）；返回更新后的完整设置 */
    async updateReminderSettings(
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
    ): Promise<ReminderSettings> {
      const columns: Record<keyof typeof patch, string> = {
        timezone: 'timezone',
        dayStartHour: 'day_start_hour',
        morningReminderEnabled: 'morning_reminder_enabled',
        morningReminderTime: 'morning_reminder_time',
        eveningReminderEnabled: 'evening_reminder_enabled',
        eveningReminderTime: 'evening_reminder_time',
        notifyOnlyIfIncomplete: 'notify_only_if_incomplete',
        theme: 'theme',
        quietEnabled: 'quiet_enabled',
        quietStart: 'quiet_start',
        quietEnd: 'quiet_end',
      };

      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [key, column] of Object.entries(columns)) {
        const value = (patch as Record<string, unknown>)[key];
        if (value === undefined) continue;
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      }

      if (sets.length > 0) {
        sets.push('updated_at = now()');
        params.push(userId);
        await db.query(`UPDATE user_settings SET ${sets.join(', ')} WHERE user_id = $${params.length}`, params);
      }

      return await this.getReminderSettings(userId);
    },

    async setSchedule(userId: string, kind: ReminderKind, nextFireAt: Date | null): Promise<void> {
      await db.query(
        `INSERT INTO reminder_schedule (user_id, kind, next_fire_at, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, kind)
         DO UPDATE SET next_fire_at = EXCLUDED.next_fire_at, updated_at = now()`,
        [userId, kind, nextFireAt],
      );
    },

    async listDueSchedules(now: Date, limit: number): Promise<DueSchedule[]> {
      const { rows } = await db.query<{ user_id: string; kind: ReminderKind; next_fire_at: string | Date }>(
        `SELECT user_id, kind, next_fire_at FROM reminder_schedule
         WHERE next_fire_at IS NOT NULL AND next_fire_at <= $1
         ORDER BY next_fire_at
         LIMIT $2`,
        [now, limit],
      );
      return rows.map((row) => ({
        userId: row.user_id,
        kind: row.kind,
        nextFireAt: new Date(row.next_fire_at),
      }));
    },

    /** 幂等占位：true = 这次是首次发送机会；false = 之前已经处理过（任务重试/重复 tick） */
    async beginDelivery(userId: string, localDate: string, kind: ReminderKind): Promise<boolean> {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO notification_deliveries (id, user_id, local_date, kind, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (user_id, local_date, kind) DO NOTHING
         RETURNING id`,
        [randomUUID(), userId, localDate, kind],
      );
      return rows.length > 0;
    },

    /** 读取某天的送达记录（重试判定用：status=sent/skipped 才表示已处理完） */
    async getDelivery(
      userId: string,
      localDate: string,
      kind: ReminderKind,
    ): Promise<{ status: DeliveryStatus; attempts: number; lastError: string | null } | null> {
      const { rows } = await db.query<{ status: DeliveryStatus; attempts: number; last_error: string | null }>(
        `SELECT status, attempts, last_error FROM notification_deliveries
         WHERE user_id = $1 AND local_date = $2 AND kind = $3`,
        [userId, localDate, kind],
      );
      const row = rows[0];
      if (!row) return null;
      return { status: row.status, attempts: Number(row.attempts), lastError: row.last_error };
    },

    async finishDelivery(
      userId: string,
      localDate: string,
      kind: ReminderKind,
      status: DeliveryStatus,
      error?: string | null,
    ): Promise<void> {
      await db.query(
        `UPDATE notification_deliveries
         SET status = $4,
             attempts = attempts + 1,
             last_error = $5,
             sent_at = CASE WHEN $4 = 'sent' THEN now() ELSE sent_at END
         WHERE user_id = $1 AND local_date = $2 AND kind = $3`,
        [userId, localDate, kind, status, error ?? null],
      );
    },

    async listReminderDeliveries(userId: string, limit: number): Promise<
      { localDate: string; kind: ReminderKind; status: DeliveryStatus; attempts: number; lastError: string | null }[]
    > {
      const { rows } = await db.query<{
        local_date: string;
        kind: ReminderKind;
        status: DeliveryStatus;
        attempts: number;
        last_error: string | null;
      }>(
        `SELECT local_date::text AS local_date, kind, status, attempts, last_error
         FROM notification_deliveries WHERE user_id = $1
         ORDER BY local_date DESC, kind LIMIT $2`,
        [userId, limit],
      );
      return rows.map((row) => ({
        localDate: row.local_date,
        kind: row.kind,
        status: row.status,
        attempts: Number(row.attempts),
        lastError: row.last_error,
      }));
    },

    async listPushSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
      const { rows } = await db.query<SubscriptionRow>(
        `SELECT ${SUBSCRIPTION_SELECT} FROM push_subscriptions
         WHERE user_id = $1 AND disabled_at IS NULL
         ORDER BY created_at`,
        [userId],
      );
      return rows.map(toSubscription);
    },

    /** upsert：endpoint 唯一。同一浏览器换账号登录时会把订阅转到新账号名下。 */
    async upsertPushSubscription(userId: string, input: PushSubscriptionInput): Promise<PushSubscriptionRecord> {
      const { rows } = await db.query<SubscriptionRow>(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (endpoint) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent,
           last_seen_at = now(),
           failure_count = 0,
           disabled_at = NULL
         RETURNING ${SUBSCRIPTION_SELECT}`,
        [randomUUID(), userId, input.endpoint, input.p256dh, input.auth, input.userAgent ?? null],
      );
      return toSubscription(rows[0] as SubscriptionRow);
    },

    async deletePushSubscription(userId: string, id: string): Promise<boolean> {
      const { rows } = await db.query(
        'DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2 RETURNING id',
        [id, userId],
      );
      return rows.length > 0;
    },

    async recordPushResult(id: string, result: 'sent' | 'failed' | 'gone', at: Date): Promise<void> {
      if (result === 'sent') {
        await db.query(
          'UPDATE push_subscriptions SET last_success_at = $2, failure_count = 0 WHERE id = $1',
          [id, at],
        );
        return;
      }
      if (result === 'gone') {
        await db.query(
          'UPDATE push_subscriptions SET disabled_at = COALESCE(disabled_at, $2), failure_count = failure_count + 1 WHERE id = $1',
          [id, at],
        );
        return;
      }
      await db.query(
        `UPDATE push_subscriptions
         SET failure_count = failure_count + 1,
             disabled_at = CASE WHEN failure_count + 1 >= $2 THEN COALESCE(disabled_at, $3) ELSE disabled_at END
         WHERE id = $1`,
        [id, FAILURE_LIMIT, at],
      );
    },
  };
}
