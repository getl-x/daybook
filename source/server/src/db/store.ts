/**
 * AppStore 的 Postgres 实现。
 *
 * 所有查询都是参数化的；字段名一律来自 diary.ts 的白名单，不做字符串拼接。
 * 表结构见 server/migrations/*.sql。
 */
import { randomUUID } from 'node:crypto';

import type { AppStore, CreateSessionInput, SessionRecord, UserRecord, UserSettings } from '../app.ts';
import {
  DIARY_TEXT_FIELDS,
  REVIEW_FIELDS,
  isOverwritten,
  type CalendarDay,
  type DiaryEntry,
  type DiaryFieldState,
  type DiaryTextField,
  type FieldUpdate,
  type Incident,
  type IncidentInput,
  type PatchResult,
} from '../diary.ts';
import type { Db } from './db.ts';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  status: UserRecord['status'];
}

interface EntryRow {
  entry_date: string;
  version: number;
  day_events: string | null;
  day_meals: string | null;
  day_plan: string | null;
  evening_summary: string | null;
  day_events_updated_at: string | Date | null;
  day_meals_updated_at: string | Date | null;
  day_plan_updated_at: string | Date | null;
  evening_summary_updated_at: string | Date | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string | Date;
  revoked_at: string | Date | null;
}

interface IncidentRow {
  id: string;
  entry_date: string;
  occurred_at: string | Date;
  content: string;
  tag: string | null;
}

const toIso = (value: string | Date | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/** SELECT 里用 `entry_date::text`，避免不同驱动把 date 解析成 Date 对象（时区会咬人） */
const ENTRY_SELECT = `entry_date::text AS entry_date, version, ${DIARY_TEXT_FIELDS.join(', ')}, ${DIARY_TEXT_FIELDS.map(
  (field) => `${field}_updated_at`,
).join(', ')}`;

function toEntry(row: EntryRow): DiaryEntry {
  const fields = {} as Record<DiaryTextField, DiaryFieldState>;
  for (const field of DIARY_TEXT_FIELDS) {
    fields[field] = {
      value: row[field],
      updatedAt: toIso(row[`${field}_updated_at` as keyof EntryRow] as string | Date | null),
    };
  }
  return { entryDate: row.entry_date, exists: true, version: Number(row.version), fields };
}

function toIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    entryDate: row.entry_date,
    occurredAt: toIso(row.occurred_at) ?? '',
    content: row.content,
    tag: row.tag,
  };
}

export function createPgStore(db: Db): AppStore {
  return {
    /* ------------------------------ 健康与账号 ------------------------------ */

    async ping(): Promise<void> {
      await db.query('SELECT 1');
    },

    async findUserByUsername(username: string): Promise<UserRecord | null> {
      const { rows } = await db.query<UserRow>(
        'SELECT id, username, password_hash, status FROM users WHERE username = $1',
        [username],
      );
      const row = rows[0];
      if (!row) return null;
      return { id: row.id, username: row.username, passwordHash: row.password_hash, status: row.status };
    },

    async findUserById(id: string): Promise<UserRecord | null> {
      const { rows } = await db.query<UserRow>(
        'SELECT id, username, password_hash, status FROM users WHERE id = $1',
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      return { id: row.id, username: row.username, passwordHash: row.password_hash, status: row.status };
    },

    async touchLastLogin(userId: string, at: Date): Promise<void> {
      await db.query('UPDATE users SET last_login_at = $2, updated_at = now() WHERE id = $1', [userId, at]);
    },

    /* -------------------------------- 会话 -------------------------------- */

    /**
     * 认证时用的一次查询：用户状态 + 该会话是否还有效。
     * 之所以合并成一句：每次请求都要校验"账号还在 + 会话没被登出/轮转作废"，
     * 拆成两次查询纯属浪费。返回 null 表示用户不存在或会话无效。
     */
    async findLiveSession(userId: string, sessionId: string, at: Date): Promise<UserRecord | null> {
      const { rows } = await db.query<UserRow & { revoked_at: string | Date | null; expires_at: string | Date }>(
        `SELECT u.id, u.username, u.password_hash, u.status, s.revoked_at, s.expires_at
         FROM users u
         JOIN refresh_tokens s ON s.user_id = u.id AND s.id = $2
         WHERE u.id = $1`,
        [userId, sessionId],
      );
      const row = rows[0];
      if (!row) return null;
      if (row.revoked_at !== null) return null;
      if (new Date(row.expires_at).getTime() <= at.getTime()) return null;
      return { id: row.id, username: row.username, passwordHash: row.password_hash, status: row.status };
    },

    /** 申请删除账号：置状态 + 记录时间，并立刻吊销全部会话、清掉推送订阅（宽限期后由后台硬删） */
    async requestAccountDeletion(userId: string, at: Date): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE users SET status = 'pending_deletion', deletion_requested_at = COALESCE(deletion_requested_at, $2), updated_at = now()
           WHERE id = $1`,
          [userId, at],
        );
        await tx.query('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE user_id = $1', [
          userId,
          at,
        ]);
        await tx.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
        await tx.query('UPDATE reminder_schedule SET next_fire_at = NULL, updated_at = now() WHERE user_id = $1', [
          userId,
        ]);
      });
    },

    async createSession(input: CreateSessionInput): Promise<void> {
      await db.query(
        'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, rotated_from) VALUES ($1, $2, $3, $4, $5)',
        [input.sessionId, input.userId, input.refreshTokenHash, input.expiresAt, input.rotatedFrom ?? null],
      );
    },

    async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
      const { rows } = await db.query<SessionRow>(
        'SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1',
        [tokenHash],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        userId: row.user_id,
        expiresAt: new Date(row.expires_at),
        revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
      };
    },

    async revokeSession(sessionId: string, at: Date): Promise<boolean> {
      const { rows } = await db.query(
        'UPDATE refresh_tokens SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id',
        [sessionId, at],
      );
      return rows.length > 0;
    },

    /* -------------------------------- 设置 -------------------------------- */

    async getUserSettings(userId: string): Promise<UserSettings> {
      const { rows } = await db.query<{ timezone: string; day_start_hour: number }>(
        'SELECT timezone, day_start_hour FROM user_settings WHERE user_id = $1',
        [userId],
      );
      const row = rows[0];
      if (!row) return { timezone: 'Asia/Shanghai', dayStartHour: 4 };
      return { timezone: row.timezone, dayStartHour: Number(row.day_start_hour) };
    },

    /* ------------------------------ 日记与突发 ----------------------------- */

    async getDiaryEntry(userId: string, entryDate: string): Promise<DiaryEntry | null> {
      const { rows } = await db.query<EntryRow>(
        `SELECT ${ENTRY_SELECT} FROM daily_entries WHERE user_id = $1 AND entry_date = $2`,
        [userId, entryDate],
      );
      const row = rows[0];
      return row ? toEntry(row) : null;
    },

    /**
     * 字段级写入（幂等地 upsert 当天那一行）。
     *
     * 事务内先 `FOR UPDATE` 读出旧值，用于逐字段判断 overwritten；
     * 字段名来自白名单，因此可以安全地拼进 SET 子句。
     */
    async upsertDiaryFields(
      userId: string,
      entryDate: string,
      updates: readonly FieldUpdate[],
      at: Date,
    ): Promise<PatchResult> {
      return await db.transaction(async (tx) => {
        // RETURNING 能区分"这一行是我刚建的"和"早就存在"——version 的语义依赖它：
        // 第一次写入应当是 version = 1，所以刚建的行不再自增。
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO daily_entries (id, user_id, entry_date) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, entry_date) DO NOTHING
           RETURNING id`,
          [randomUUID(), userId, entryDate],
        );
        const isNewRow = inserted.rows.length > 0;

        const existing = await tx.query<EntryRow>(
          `SELECT ${ENTRY_SELECT} FROM daily_entries WHERE user_id = $1 AND entry_date = $2 FOR UPDATE`,
          [userId, entryDate],
        );
        const before = existing.rows[0];

        const sets: string[] = [];
        const params: unknown[] = [];
        for (const update of updates) {
          params.push(update.value);
          sets.push(`${update.field} = $${params.length}`);
          params.push(at);
          sets.push(`${update.field}_updated_at = $${params.length}`);
        }
        // 新建的行已经由默认值拿到 version = 1（= 第一次写入），不再 +1
        if (!isNewRow) sets.push('version = version + 1');
        sets.push('updated_at = now()');

        const touchedReview = updates.some(
          (update) => REVIEW_FIELDS.includes(update.field) && update.value.trim() !== '',
        );
        const touchedSummary = updates.some(
          (update) => update.field === 'evening_summary' && update.value.trim() !== '',
        );
        if (touchedReview) sets.push('reviewed_at = COALESCE(reviewed_at, now())');
        if (touchedSummary) sets.push('summarized_at = COALESCE(summarized_at, now())');

        params.push(userId);
        const userParam = `$${params.length}`;
        params.push(entryDate);
        const dateParam = `$${params.length}`;

        const written = await tx.query<EntryRow>(
          `UPDATE daily_entries SET ${sets.join(', ')}
           WHERE user_id = ${userParam} AND entry_date = ${dateParam}
           RETURNING ${ENTRY_SELECT}`,
          params,
        );

        const nowIso = at.toISOString();
        const result: PatchResult = { entryDate, version: 0, fields: {} };
        for (const update of updates) {
          const previous = before
            ? toIso(before[`${update.field}_updated_at` as keyof EntryRow] as string | Date | null)
            : null;
          result.fields[update.field] = {
            value: update.value,
            updatedAt: nowIso,
            overwritten: isOverwritten(update.baseUpdatedAt, previous),
          };
        }
        result.version = Number(written.rows[0]?.version ?? (before ? Number(before.version) + 1 : 1));
        return result;
      });
    },

    async listIncidents(userId: string, entryDate: string): Promise<Incident[]> {
      const { rows } = await db.query<IncidentRow>(
        `SELECT id, entry_date::text AS entry_date, occurred_at, content, tag
         FROM incidents WHERE user_id = $1 AND entry_date = $2
         ORDER BY occurred_at, created_at`,
        [userId, entryDate],
      );
      return rows.map(toIncident);
    },

    /**
     * 新建突发事情：id 由客户端生成，`ON CONFLICT DO NOTHING` 让重复提交幂等。
     * 若该 id 已被**别人**占用（客户端 UUID 撞车），返回 null 由路由层映射成 409。
     */
    async createIncident(
      userId: string,
      input: IncidentInput & { entryDate: string },
    ): Promise<{ incident: Incident; created: boolean } | null> {
      const inserted = await db.query<IncidentRow>(
        `INSERT INTO incidents (id, user_id, entry_date, occurred_at, content, tag)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, entry_date::text AS entry_date, occurred_at, content, tag`,
        [input.id, userId, input.entryDate, input.occurredAt, input.content, input.tag],
      );

      const row = inserted.rows[0];
      if (row) return { incident: toIncident(row), created: true };

      // 已存在：只有本人的那条才算幂等重放
      const existing = await db.query<IncidentRow>(
        `SELECT id, entry_date::text AS entry_date, occurred_at, content, tag
         FROM incidents WHERE id = $1 AND user_id = $2`,
        [input.id, userId],
      );
      const found = existing.rows[0];
      return found ? { incident: toIncident(found), created: false } : null;
    },

    /** 只更新传进来的字段；改了 occurred_at 就同时更新归属日（跨日移动，计划 §5.4）。 */
    async updateIncident(
      userId: string,
      id: string,
      changes: { content?: string; occurredAt?: string; tag?: string | null; entryDate?: string },
    ): Promise<Incident | null> {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (changes.content !== undefined) {
        params.push(changes.content);
        sets.push(`content = $${params.length}`);
      }
      if (changes.occurredAt !== undefined) {
        params.push(changes.occurredAt);
        sets.push(`occurred_at = $${params.length}`);
      }
      if (changes.entryDate !== undefined) {
        params.push(changes.entryDate);
        sets.push(`entry_date = $${params.length}`);
      }
      if (changes.tag !== undefined) {
        params.push(changes.tag);
        sets.push(`tag = $${params.length}`);
      }
      if (sets.length === 0) return null;

      sets.push('updated_at = now()');
      params.push(id);
      const idParam = `$${params.length}`;
      params.push(userId);
      const userParam = `$${params.length}`;

      const { rows } = await db.query<IncidentRow>(
        `UPDATE incidents SET ${sets.join(', ')}
         WHERE id = ${idParam} AND user_id = ${userParam}
         RETURNING id, entry_date::text AS entry_date, occurred_at, content, tag`,
        params,
      );
      const row = rows[0];
      return row ? toIncident(row) : null;
    },

    async deleteIncident(userId: string, id: string): Promise<boolean> {
      const result = await db.query('DELETE FROM incidents WHERE id = $1 AND user_id = $2 RETURNING id', [
        id,
        userId,
      ]);
      return result.rows.length > 0;
    },

    /** 日历：某月里有内容的日期 + 每天的突发条数（两边任一边有数据都算这一天有记录）。 */
    async listEntryDates(userId: string, startDate: string, endDate: string): Promise<CalendarDay[]> {
      const { rows } = await db.query<{
        date: string;
        has_content: boolean;
        incident_count: number;
      }>(
        `WITH dates AS (
           SELECT entry_date FROM daily_entries WHERE user_id = $1 AND entry_date >= $2 AND entry_date < $3
           UNION
           SELECT entry_date FROM incidents WHERE user_id = $1 AND entry_date >= $2 AND entry_date < $3
         )
         SELECT d.entry_date::text AS date,
                COALESCE(e.day_events, '') <> ''
                  OR COALESCE(e.day_meals, '') <> ''
                  OR COALESCE(e.day_plan, '') <> ''
                  OR COALESCE(e.evening_summary, '') <> '' AS has_content,
                (SELECT count(*)::int FROM incidents i
                  WHERE i.user_id = $1 AND i.entry_date = d.entry_date) AS incident_count
         FROM dates d
         LEFT JOIN daily_entries e ON e.user_id = $1 AND e.entry_date = d.entry_date
         ORDER BY d.entry_date`,
        [userId, startDate, endDate],
      );
      return rows.map((row) => ({
        date: row.date,
        hasContent: row.has_content,
        incidentCount: Number(row.incident_count),
      }));
    },
  };
}
