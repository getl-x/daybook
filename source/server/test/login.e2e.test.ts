/**
 * 端到端（在进程内）：真实 Postgres（PGlite）+ 真实 store + Fastify inject。
 * 覆盖"管理员建号 → 登录 → 会话落库 → 停用后登录被拒"整条链路。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildApp } from '../src/app.ts';
import { hashRefreshToken, verifyAccessToken } from '../src/auth.ts';
import type { Config } from '../src/config.ts';
import { createNotificationStore } from '../src/db/notification-store.ts';
import { createPgStore } from '../src/db/store.ts';
import { createUser, setUserStatus } from '../src/users.ts';
import { createTestDb } from './helpers/pglite.ts';

const SECRET = 'e2e-secret-0123456789abcdef';
const PASSWORD = 'correct horse battery';

const config: Config = {
  nodeEnv: 'test',
  port: 8090,
  databaseUrl: 'postgres://unused:unused@localhost:5432/unused',
  jwtSecret: SECRET,
  logLevel: 'silent',
  vapid: null,
};

async function bootstrap() {
  const db = await createTestDb();
  // 合并两个 store：接口层需要日记 + 提醒两套能力
  const store = { ...createPgStore(db), ...createNotificationStore(db) };
  const app = buildApp({ config, store });
  return { db, app };
}

describe('登录链路（真实数据库）', () => {
  it('建号 → 登录成功 → 会话与最后登录时间落库 → 令牌可验', async () => {
    const { db, app } = await bootstrap();
    const user = await createUser(db, { username: 'getl', password: PASSWORD });

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().db, 'ok');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'getl', password: PASSWORD },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();

    const claims = verifyAccessToken(body.accessToken, SECRET);
    assert.ok(claims);
    assert.equal(claims.sub, user.id);

    const sessions = await db.query<{ id: string; token_hash: string; expires_at: Date }>(
      'SELECT id, token_hash, expires_at FROM refresh_tokens WHERE user_id = $1',
      [user.id],
    );
    assert.equal(sessions.rows.length, 1);
    assert.equal(sessions.rows[0].id, claims.sid);
    assert.equal(sessions.rows[0].token_hash, hashRefreshToken(body.refreshToken));

    const lastLogin = await db.query<{ last_login_at: Date | null }>('SELECT last_login_at FROM users WHERE id = $1', [
      user.id,
    ]);
    assert.ok(lastLogin.rows[0].last_login_at instanceof Date);

    await app.close();
    await db.close();
  });

  it('口令错误 → 401，且不会留下会话', async () => {
    const { db, app } = await bootstrap();
    const user = await createUser(db, { username: 'getl', password: PASSWORD });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'getl', password: 'wrong horse battery' },
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'invalid_credentials' });

    const sessions = await db.query('SELECT id FROM refresh_tokens WHERE user_id = $1', [user.id]);
    assert.equal(sessions.rows.length, 0);
    await app.close();
    await db.close();
  });

  it('账号被停用后，即使口令正确也登录不了', async () => {
    const { db, app } = await bootstrap();
    await createUser(db, { username: 'getl', password: PASSWORD });
    await setUserStatus(db, { username: 'getl', status: 'disabled' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'getl', password: PASSWORD },
    });
    assert.equal(response.statusCode, 401);
    await app.close();
    await db.close();
  });

  it('两个账号之间数据隔离（各自只有自己的会话）', async () => {
    const { db, app } = await bootstrap();
    await createUser(db, { username: 'alice', password: PASSWORD });
    await createUser(db, { username: 'bob', password: PASSWORD });

    const alice = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'alice', password: PASSWORD },
    });
    assert.equal(alice.statusCode, 200);
    const claims = verifyAccessToken(alice.json().accessToken, SECRET);
    assert.ok(claims);

    const others = await db.query<{ username: string }>(
      `SELECT u.username FROM refresh_tokens t JOIN users u ON u.id = t.user_id WHERE t.id <> $1`,
      [claims.sid],
    );
    assert.deepEqual(others.rows, []);
    await app.close();
    await db.close();
  });
});
