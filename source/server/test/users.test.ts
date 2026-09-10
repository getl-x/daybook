/**
 * 账号管理（管理员侧）的真实 SQL 测试：建号 / 重置口令 / 启停 / 列表。
 * 跑在 PGlite（进程内真 Postgres）上——约束、默认值、唯一索引都是真的。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PasswordPolicyError, verifyPassword } from '../src/auth.ts';
import { UserAdminError, createUser, listUsers, resetPassword, setUserStatus } from '../src/users.ts';
import { createTestDb } from './helpers/pglite.ts';

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'another battery staple';

describe('createUser', () => {
  it('建档成功：状态 active，并自动带上默认设置行（时区 Asia/Shanghai）', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: '  GetL  ', password: PASSWORD });

    assert.equal(user.username, 'getl', '用户名会被归一化成小写去空格');
    assert.equal(user.status, 'active');
    assert.ok(user.id.match(/^[0-9a-f-]{36}$/));
    assert.equal(user.lastLoginAt, null);

    const settings = await db.query<{ timezone: string; day_start_hour: number; morning_reminder_time: string }>(
      'SELECT timezone, day_start_hour, morning_reminder_time FROM user_settings WHERE user_id = $1',
      [user.id],
    );
    assert.equal(settings.rows.length, 1);
    assert.equal(settings.rows[0].timezone, 'Asia/Shanghai');
    assert.equal(settings.rows[0].day_start_hour, 4);
    // 注意：PG 的 time 类型取回来带秒（'09:00:00'）
    assert.equal(settings.rows[0].morning_reminder_time, '09:00:00');

    // 口令落库的是 scrypt 哈希，能验回
    const stored = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    assert.match(stored.rows[0].password_hash, /^scrypt\$/);
    assert.equal(await verifyPassword(PASSWORD, stored.rows[0].password_hash), true);
    await db.close();
  });

  it('可以指定时区', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'newyork', password: PASSWORD, timezone: 'America/New_York' });
    const settings = await db.query<{ timezone: string }>('SELECT timezone FROM user_settings WHERE user_id = $1', [
      user.id,
    ]);
    assert.equal(settings.rows[0].timezone, 'America/New_York');
    await db.close();
  });

  it('重名账号被拒，且错误信息友好', async () => {
    const db = await createTestDb();
    await createUser(db, { username: 'getl', password: PASSWORD });
    await assert.rejects(
      () => createUser(db, { username: 'GETL', password: PASSWORD }),
      (error: unknown) => error instanceof UserAdminError && error.code === 'already_exists',
    );
    // 失败时不该留下半条记录
    const users = await db.query('SELECT id FROM users');
    assert.equal(users.rows.length, 1);
    await db.close();
  });

  it('非法用户名与弱口令都被拒', async () => {
    const db = await createTestDb();
    for (const username of ['ab', 'a'.repeat(33), '中文名', 'a b', 'a.b']) {
      await assert.rejects(
        () => createUser(db, { username, password: PASSWORD }),
        (error: unknown) => error instanceof UserAdminError && error.code === 'invalid_username',
        `应拒绝用户名 ${username}`,
      );
    }
    await assert.rejects(() => createUser(db, { username: 'getl', password: 'short' }), PasswordPolicyError);
    await db.close();
  });
});

describe('resetPassword / setUserStatus / listUsers', () => {
  it('重置口令后：旧口令失效、新口令可用', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'getl', password: PASSWORD });

    await resetPassword(db, { username: ' getl ', password: NEW_PASSWORD });

    const { rows } = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [
      user.id,
    ]);
    assert.equal(await verifyPassword(NEW_PASSWORD, rows[0].password_hash), true);
    assert.equal(await verifyPassword(PASSWORD, rows[0].password_hash), false);
    await db.close();
  });

  it('对不存在的账号操作会报 not_found', async () => {
    const db = await createTestDb();
    await assert.rejects(
      () => resetPassword(db, { username: 'nobody', password: NEW_PASSWORD }),
      (error: unknown) => error instanceof UserAdminError && error.code === 'not_found',
    );
    await assert.rejects(
      () => setUserStatus(db, { username: 'nobody', status: 'disabled' }),
      (error: unknown) => error instanceof UserAdminError && error.code === 'not_found',
    );
    await db.close();
  });

  it('停用与重新启用', async () => {
    const db = await createTestDb();
    await createUser(db, { username: 'getl', password: PASSWORD });

    const disabled = await setUserStatus(db, { username: 'getl', status: 'disabled' });
    assert.equal(disabled.status, 'disabled');

    const enabled = await setUserStatus(db, { username: 'getl', status: 'active' });
    assert.equal(enabled.status, 'active');

    await assert.rejects(
      () => setUserStatus(db, { username: 'getl', status: 'whatever' as 'active' }),
      (error: unknown) => error instanceof UserAdminError && error.code === 'invalid_status',
    );
    await db.close();
  });

  it('listUsers 按创建时间返回所有账号', async () => {
    const db = await createTestDb();
    await createUser(db, { username: 'aaa', password: PASSWORD });
    await createUser(db, { username: 'bbb', password: PASSWORD });

    const users = await listUsers(db);
    assert.deepEqual(
      users.map((user) => user.username),
      ['aaa', 'bbb'],
    );
    await db.close();
  });
});
