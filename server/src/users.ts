/**
 * 账号管理（管理员侧）：建号、重置口令、启用/停用、列表。
 *
 * 这里是纯函数式的领域操作，CLI（src/cli/user.ts）与将来的管理页都调它，
 * 因此可以直接用真实 SQL 测试（见 test/users.test.ts）。
 */
import { randomUUID } from 'node:crypto';

import { hashPassword, isValidUsername, normalizeUsername } from './auth.ts';
import { isUniqueViolation, type Db } from './db/db.ts';

export type UserStatus = 'active' | 'disabled' | 'pending_deletion';

export interface UserSummary {
  id: string;
  username: string;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
}

export type UserAdminErrorCode = 'invalid_username' | 'already_exists' | 'not_found' | 'invalid_status';

export class UserAdminError extends Error {
  readonly code: UserAdminErrorCode;

  constructor(code: UserAdminErrorCode, message: string) {
    super(message);
    this.name = 'UserAdminError';
    this.code = code;
  }
}

interface UserSummaryRow {
  id: string;
  username: string;
  status: UserStatus;
  created_at: Date | string;
  last_login_at: Date | string | null;
}

const toIso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function toSummary(row: UserSummaryRow): UserSummary {
  return {
    id: row.id,
    username: row.username,
    status: row.status,
    createdAt: toIso(row.created_at) ?? '',
    lastLoginAt: toIso(row.last_login_at),
  };
}

function requireUsername(raw: string): string {
  const username = normalizeUsername(raw);
  if (!isValidUsername(username)) {
    throw new UserAdminError(
      'invalid_username',
      `用户名不合法：${raw}（3–32 位，只允许小写字母、数字、下划线、连字符）`,
    );
  }
  return username;
}

export async function createUser(
  db: Db,
  input: { username: string; password: string; timezone?: string },
): Promise<UserSummary> {
  const username = requireUsername(input.username);
  // 口令策略校验在 hashPassword 里（太短/太简单会抛 PasswordPolicyError）
  const passwordHash = await hashPassword(input.password);
  const id = randomUUID();

  try {
    return await db.transaction(async (tx) => {
      await tx.query('INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)', [
        id,
        username,
        passwordHash,
      ]);
      // 不传 timezone 就只插 user_id，让数据库默认值（Asia/Shanghai）生效
      if (input.timezone) {
        await tx.query('INSERT INTO user_settings (user_id, timezone) VALUES ($1, $2)', [id, input.timezone]);
      } else {
        await tx.query('INSERT INTO user_settings (user_id) VALUES ($1)', [id]);
      }
      const { rows } = await tx.query<UserSummaryRow>(
        'SELECT id, username, status, created_at, last_login_at FROM users WHERE id = $1',
        [id],
      );
      return toSummary(rows[0]);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new UserAdminError('already_exists', `账号 ${username} 已存在`);
    }
    throw error;
  }
}

export async function resetPassword(db: Db, input: { username: string; password: string }): Promise<UserSummary> {
  const username = requireUsername(input.username);
  const passwordHash = await hashPassword(input.password);
  const { rows } = await db.query<UserSummaryRow>(
    `UPDATE users SET password_hash = $2, updated_at = now()
     WHERE username = $1
     RETURNING id, username, status, created_at, last_login_at`,
    [username, passwordHash],
  );
  if (rows.length === 0) throw new UserAdminError('not_found', `账号 ${username} 不存在`);
  return toSummary(rows[0]);
}

export async function setUserStatus(
  db: Db,
  input: { username: string; status: UserStatus },
): Promise<UserSummary> {
  const username = requireUsername(input.username);
  if (input.status !== 'active' && input.status !== 'disabled' && input.status !== 'pending_deletion') {
    throw new UserAdminError('invalid_status', `不支持的状态：${input.status}`);
  }
  const { rows } = await db.query<UserSummaryRow>(
    `UPDATE users SET status = $2, updated_at = now()
     WHERE username = $1
     RETURNING id, username, status, created_at, last_login_at`,
    [username, input.status],
  );
  if (rows.length === 0) throw new UserAdminError('not_found', `账号 ${username} 不存在`);
  return toSummary(rows[0]);
}

export async function listUsers(db: Db): Promise<UserSummary[]> {
  const { rows } = await db.query<UserSummaryRow>(
    'SELECT id, username, status, created_at, last_login_at FROM users ORDER BY created_at',
  );
  return rows.map(toSummary);
}

/** 宽限期（默认 7 天）过后真正清除账号：ON DELETE CASCADE 会带走日记、突发、订阅、会话 */
export async function purgeExpiredAccounts(db: Db, graceDays = 7, now: Date = new Date()): Promise<number> {
  const { rows } = await db.query<{ id: string; username: string }>(
    `DELETE FROM users
     WHERE status = 'pending_deletion'
       AND deletion_requested_at IS NOT NULL
       AND deletion_requested_at <= $1
     RETURNING id, username`,
    [new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000)],
  );
  return rows.length;
}

/** 管理员强制清除某个账号（不进宽限期），用于 CLI */
export async function purgeUser(db: Db, username: string): Promise<void> {
  const normalized = requireUsername(username);
  const { rows } = await db.query('DELETE FROM users WHERE username = $1 RETURNING id', [normalized]);
  if (rows.length === 0) throw new UserAdminError('not_found', `账号 ${normalized} 不存在`);
}
