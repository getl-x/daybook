/**
 * 内存版 store：接口层测试用，完全不碰数据库。
 *
 * 同时实现 AppStore（认证/日记/突发/日历）与 NotificationStore（提醒/排程/送达/订阅），
 * 语义刻意与 src/db/*.ts 的 SQL 实现保持一致，这样路由与调度器测试才有意义。
 */
import { randomUUID } from 'node:crypto';

import type { AppStore, CreateSessionInput, SessionRecord, UserRecord, UserSettings } from '../../src/app.ts';
import {
  isOverwritten,
  type CalendarDay,
  type DiaryEntry,
  type FieldUpdate,
  type Incident,
  type IncidentInput,
  type PatchResult,
} from '../../src/diary.ts';
import type {
  DeliveryStatus,
  DueSchedule,
  NotificationStore,
  PushSubscriptionInput,
  PushSubscriptionRecord,
  ReminderKind,
  ReminderSettings,
} from '../../src/notifications.ts';

interface StoredSession extends SessionRecord {
  tokenHash: string;
  rotatedFrom: string | null;
}

interface StoredDelivery {
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
}

export interface FakeStore extends AppStore, NotificationStore {
  readonly users: Map<string, UserRecord>;
  readonly sessions: Map<string, StoredSession>;
  readonly incidents: Map<string, Incident>;
  readonly lastLogins: { userId: string; at: Date }[];
  /** 直接塞一条排程，用于调度器测试 */
  readonly schedules: Map<string, Date | null>;
  readonly deliveries: Map<string, StoredDelivery>;
  readonly pushSubscriptions: Map<string, PushSubscriptionRecord & { userId: string }>;
  /** 应用级键值设置（如自动生成的 VAPID 密钥） */
  readonly appSettings: Map<string, string>;
  setSettings(userId: string, settings: UserSettings): void;
  addUser(input: { username: string; passwordHash: string; status?: UserRecord['status'] }): UserRecord;
  /** 直接塞一条突发事情（含归属人），用于读接口测试 */
  seedIncident(userId: string, incident: Incident): void;
  /** 直接塞一条日记，用于读接口测试 */
  seedEntry(userId: string, entry: DiaryEntry): void;
  seedSchedule(userId: string, kind: ReminderKind, nextFireAt: Date | null): void;
  /** 让 /healthz 返回 503 */
  failPing: boolean;
}

const DEFAULT_REMINDERS: Omit<ReminderSettings, 'timezone' | 'dayStartHour'> = {
  morningReminderEnabled: true,
  morningReminderTime: '09:00',
  eveningReminderEnabled: true,
  eveningReminderTime: '21:00',
  notifyOnlyIfIncomplete: true,
  quietHours: { enabled: false, start: '', end: '' },
};

/** 与 SQL 实现里的 FAILURE_LIMIT 保持一致 */
const FAILURE_LIMIT = 10;

export function createFakeStore(): FakeStore {
  const users = new Map<string, UserRecord>();
  const sessions = new Map<string, StoredSession>();
  /** key: `${userId}:${entryDate}` */
  const entries = new Map<string, DiaryEntry>();
  /** key: incident id */
  const incidentList = new Map<string, Incident>();
  /** incident id → 归属用户（SQL 版是 incidents.user_id 列） */
  const incidentOwners = new Map<string, string>();
  const settings = new Map<string, UserSettings>();
  const reminderSettings = new Map<string, ReminderSettings>();
  const lastLogins: { userId: string; at: Date }[] = [];
  /** key: `${userId}:${kind}` */
  const schedules = new Map<string, Date | null>();
  /** key: `${userId}:${localDate}:${kind}` */
  const deliveries = new Map<string, StoredDelivery>();
  /** key: subscription id（endpoint 唯一） */
  const pushSubscriptions = new Map<string, PushSubscriptionRecord & { userId: string }>();
  const appSettings = new Map<string, string>();

  const entryKey = (userId: string, date: string): string => `${userId}:${date}`;
  const scheduleKey = (userId: string, kind: ReminderKind): string => `${userId}:${kind}`;
  const deliveryKey = (userId: string, date: string, kind: ReminderKind): string => `${userId}:${date}:${kind}`;
  const ownsIncident = (userId: string, id: string): boolean => incidentOwners.get(id) === userId;

  const store: FakeStore = {
    users,
    sessions,
    incidents: incidentList,
    lastLogins,
    schedules,
    deliveries,
    pushSubscriptions,
    appSettings,
    failPing: false,

    setSettings(userId, value) {
      settings.set(userId, value);
      reminderSettings.set(userId, { ...value, ...DEFAULT_REMINDERS });
    },

    addUser({ username, passwordHash, status = 'active' }) {
      const user: UserRecord = { id: randomUUID(), username, passwordHash, status };
      users.set(user.id, user);
      return user;
    },

    seedIncident(userId, incident) {
      incidentList.set(incident.id, incident);
      incidentOwners.set(incident.id, userId);
    },

    seedEntry(userId, entry) {
      entries.set(entryKey(userId, entry.entryDate), entry);
    },

    seedSchedule(userId, kind, nextFireAt) {
      schedules.set(scheduleKey(userId, kind), nextFireAt);
    },

    async ping() {
      if (store.failPing) throw new Error('database is down');
    },

    async findUserByUsername(username) {
      for (const user of users.values()) if (user.username === username) return user;
      return null;
    },

    async findUserById(id) {
      return users.get(id) ?? null;
    },

    async findLiveSession(userId, sessionId, at) {
      const user = users.get(userId);
      if (!user) return null;
      const session = sessions.get(sessionId);
      if (!session || session.userId !== userId) return null;
      if (session.revokedAt !== null) return null;
      if (session.expiresAt.getTime() <= at.getTime()) return null;
      return user;
    },

    async requestAccountDeletion(userId, at) {
      const user = users.get(userId);
      if (user) user.status = 'pending_deletion';
      for (const session of sessions.values()) {
        if (session.userId === userId && session.revokedAt === null) session.revokedAt = at;
      }
      for (const [id, subscription] of pushSubscriptions) {
        if (subscription.userId === userId) pushSubscriptions.delete(id);
      }
      for (const kind of ['morning', 'evening'] as const) schedules.set(scheduleKey(userId, kind), null);
    },

    async createSession(input: CreateSessionInput) {
      sessions.set(input.sessionId, {
        id: input.sessionId,
        userId: input.userId,
        expiresAt: input.expiresAt,
        revokedAt: null,
        tokenHash: input.refreshTokenHash,
        rotatedFrom: input.rotatedFrom ?? null,
      });
    },

    async findSessionByTokenHash(tokenHash) {
      for (const session of sessions.values()) if (session.tokenHash === tokenHash) return session;
      return null;
    },

    async revokeSession(sessionId, at) {
      const session = sessions.get(sessionId);
      if (!session || session.revokedAt !== null) return false;
      session.revokedAt = at;
      return true;
    },

    async touchLastLogin(userId, at) {
      lastLogins.push({ userId, at });
    },

    async getUserSettings(userId) {
      return settings.get(userId) ?? { timezone: 'Asia/Shanghai', dayStartHour: 4 };
    },

    async getAppSetting(key) {
      return appSettings.get(key) ?? null;
    },

    async setAppSetting(key, value) {
      appSettings.set(key, value);
    },

    async getDiaryEntry(userId, entryDate) {
      return entries.get(entryKey(userId, entryDate)) ?? null;
    },

    async upsertDiaryFields(userId, entryDate, updates: readonly FieldUpdate[], at): Promise<PatchResult> {
      const existing = entries.get(entryKey(userId, entryDate));
      const entry: DiaryEntry = existing ?? {
        entryDate,
        exists: true,
        version: 0,
        fields: {
          day_events: { value: null, updatedAt: null },
          day_meals: { value: null, updatedAt: null },
          day_plan: { value: null, updatedAt: null },
          evening_summary: { value: null, updatedAt: null },
        },
      };

      const result: PatchResult = { entryDate, version: entry.version + 1, fields: {} };
      for (const update of updates) {
        const before = entry.fields[update.field];
        result.fields[update.field] = {
          value: update.value,
          updatedAt: at.toISOString(),
          overwritten: isOverwritten(update.baseUpdatedAt, before.updatedAt),
        };
        entry.fields[update.field] = { value: update.value, updatedAt: at.toISOString() };
      }
      entry.version += 1;
      entry.exists = true;
      entries.set(entryKey(userId, entryDate), entry);
      return result;
    },

    async listIncidents(userId, entryDate) {
      return [...incidentList.values()]
        .filter((incident) => incident.entryDate === entryDate && ownsIncident(userId, incident.id))
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    },

    async createIncident(userId, input: IncidentInput & { entryDate: string }) {
      const existing = incidentList.get(input.id);
      if (existing) {
        // 幂等重放：只有本人的那条才算；别人的 id 视为冲突
        return ownsIncident(userId, input.id) ? { incident: existing, created: false } : null;
      }
      const incident: Incident = {
        id: input.id,
        entryDate: input.entryDate,
        occurredAt: input.occurredAt,
        content: input.content,
        tag: input.tag,
      };
      incidentList.set(incident.id, incident);
      incidentOwners.set(incident.id, userId);
      return { incident, created: true };
    },

    async updateIncident(
      userId,
      id,
      changes: { content?: string; occurredAt?: string; tag?: string | null; entryDate?: string },
    ) {
      const incident = incidentList.get(id);
      if (!incident || !ownsIncident(userId, id)) return null;

      const next: Incident = { ...incident };
      if (changes.content !== undefined) next.content = changes.content;
      if (changes.occurredAt !== undefined) next.occurredAt = changes.occurredAt;
      if (changes.entryDate !== undefined) next.entryDate = changes.entryDate;
      if (changes.tag !== undefined) next.tag = changes.tag;
      incidentList.set(id, next);
      return next;
    },

    async deleteIncident(userId, id) {
      if (!ownsIncident(userId, id)) return false;
      incidentOwners.delete(id);
      return incidentList.delete(id);
    },

    async listEntryDates(userId, startDate, endDate): Promise<CalendarDay[]> {
      const dates = new Set<string>();
      for (const [key, entry] of entries) {
        const [owner, date] = key.split(':');
        if (owner === userId && date !== undefined && date >= startDate && date < endDate) dates.add(date);
      }
      for (const [id, incident] of incidentList) {
        if (ownsIncident(userId, id) && incident.entryDate >= startDate && incident.entryDate < endDate) {
          dates.add(incident.entryDate);
        }
      }

      return [...dates].sort().map((date) => {
        const entry = entries.get(entryKey(userId, date));
        const hasContent = entry
          ? Object.values(entry.fields).some((field) => (field.value ?? '') !== '')
          : false;
        const incidentCount = [...incidentList.values()].filter(
          (incident) => incident.entryDate === date && ownsIncident(userId, incident.id),
        ).length;
        return { date, hasContent, incidentCount };
      });
    },

    /* ------------------------------ 提醒与推送 ------------------------------ */

    async getReminderSettings(userId) {
      const existing = reminderSettings.get(userId);
      if (existing) return existing;
      const base = settings.get(userId) ?? { timezone: 'Asia/Shanghai', dayStartHour: 4 };
      return { ...base, ...DEFAULT_REMINDERS };
    },

    async updateReminderSettings(userId, patch) {
      const current = await store.getReminderSettings(userId);
      const next: ReminderSettings = { ...current };
      if (patch.timezone !== undefined) next.timezone = patch.timezone;
      if (patch.dayStartHour !== undefined) next.dayStartHour = patch.dayStartHour;
      if (patch.morningReminderEnabled !== undefined) next.morningReminderEnabled = patch.morningReminderEnabled;
      if (patch.morningReminderTime !== undefined) next.morningReminderTime = patch.morningReminderTime;
      if (patch.eveningReminderEnabled !== undefined) next.eveningReminderEnabled = patch.eveningReminderEnabled;
      if (patch.eveningReminderTime !== undefined) next.eveningReminderTime = patch.eveningReminderTime;
      if (patch.notifyOnlyIfIncomplete !== undefined) next.notifyOnlyIfIncomplete = patch.notifyOnlyIfIncomplete;
      if (patch.quietEnabled !== undefined) next.quietHours = { ...next.quietHours, enabled: patch.quietEnabled };
      if (patch.quietStart !== undefined) next.quietHours = { ...next.quietHours, start: patch.quietStart };
      if (patch.quietEnd !== undefined) next.quietHours = { ...next.quietHours, end: patch.quietEnd };
      reminderSettings.set(userId, next);
      settings.set(userId, { timezone: next.timezone, dayStartHour: next.dayStartHour });
      return next;
    },

    async setSchedule(userId, kind, nextFireAt) {
      schedules.set(scheduleKey(userId, kind), nextFireAt);
    },

    async listDueSchedules(now, limit): Promise<DueSchedule[]> {
      return [...schedules.entries()]
        .filter(([, nextFireAt]) => nextFireAt !== null && nextFireAt.getTime() <= now.getTime())
        .map(([key, nextFireAt]) => {
          const [userId, kind] = key.split(':');
          return { userId: userId ?? '', kind: (kind ?? 'morning') as ReminderKind, nextFireAt: nextFireAt as Date };
        })
        .slice(0, limit);
    },

    async beginDelivery(userId, localDate, kind) {
      const key = deliveryKey(userId, localDate, kind);
      if (deliveries.has(key)) return false;
      deliveries.set(key, { status: 'pending', attempts: 0, lastError: null });
      return true;
    },

    async getDelivery(userId, localDate, kind) {
      return deliveries.get(deliveryKey(userId, localDate, kind)) ?? null;
    },

    async finishDelivery(userId, localDate, kind, status, error) {
      const key = deliveryKey(userId, localDate, kind);
      const current = deliveries.get(key) ?? { status, attempts: 0, lastError: null };
      deliveries.set(key, {
        status,
        attempts: current.attempts + 1,
        lastError: error ?? null,
      });
    },

    async listReminderDeliveries(userId, limit) {
      return [...deliveries.entries()]
        .filter(([key]) => key.startsWith(`${userId}:`))
        .slice(-limit)
        .map(([key, value]) => {
          const [, localDate, kind] = key.split(':');
          return {
            localDate: localDate ?? '',
            kind: (kind ?? 'morning') as ReminderKind,
            status: value.status,
            attempts: value.attempts,
            lastError: value.lastError,
          };
        });
    },

    async listPushSubscriptions(userId) {
      return [...pushSubscriptions.values()].filter(
        (subscription) => subscription.userId === userId && subscription.disabledAt === null,
      );
    },

    async upsertPushSubscription(userId, input: PushSubscriptionInput) {
      for (const [id, existing] of pushSubscriptions) {
        if (existing.endpoint !== input.endpoint) continue;
        const next = {
          ...existing,
          userId,
          p256dh: input.p256dh,
          auth: input.auth,
          userAgent: input.userAgent ?? null,
          disabledAt: null,
          failureCount: 0,
        };
        pushSubscriptions.set(id, next);
        return next;
      }
      const created: PushSubscriptionRecord & { userId: string } = {
        id: randomUUID(),
        userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
        disabledAt: null,
        failureCount: 0,
        createdAt: new Date(),
      };
      pushSubscriptions.set(created.id, created);
      return created;
    },

    async deletePushSubscription(userId, id) {
      const existing = pushSubscriptions.get(id);
      if (!existing || existing.userId !== userId) return false;
      return pushSubscriptions.delete(id);
    },

    async recordPushResult(id, result, at) {
      const existing = pushSubscriptions.get(id);
      if (!existing) return;
      if (result === 'sent') {
        pushSubscriptions.set(id, { ...existing, failureCount: 0 });
        return;
      }
      const failureCount = existing.failureCount + 1;
      pushSubscriptions.set(id, {
        ...existing,
        failureCount,
        disabledAt:
          result === 'gone' || failureCount >= FAILURE_LIMIT ? (existing.disabledAt ?? at) : existing.disabledAt,
      });
    },
  };

  return store;
}
