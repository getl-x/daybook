/**
 * 接口层测试：不连数据库，用内存 store（test/helpers/fake-store.ts）+ app.inject()。
 * 覆盖 /healthz、登录成功/失败/停用/非法用户名/参数校验/限流。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LoginRateLimiter, buildApp, type AppStore } from '../src/app.ts';
import { hashPassword, hashRefreshToken, verifyAccessToken } from '../src/auth.ts';
import type { Config } from '../src/config.ts';
import type { NotificationStore } from '../src/notifications.ts';
import { createFakeStore, type FakeStore } from './helpers/fake-store.ts';

const SECRET = 'test-secret-0123456789abcdef';
const PASSWORD = 'correct horse battery';
const FIXED_NOW = new Date('2026-09-10T12:00:00Z');

const PASSWORD_HASH = await hashPassword(PASSWORD);

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    port: 8090,
    databaseUrl: 'postgres://daybook:secret@localhost:5432/daybook',
    jwtSecret: SECRET,
    logLevel: 'silent',
    vapid: null,
    ...overrides,
  };
}

/** 建一个带 getl 账号的 store */
function storeWithUser(status: 'active' | 'disabled' = 'active'): FakeStore {
  const store = createFakeStore();
  store.addUser({ username: 'getl', passwordHash: PASSWORD_HASH, status });
  return store;
}

function appWith(store: AppStore & NotificationStore) {
  return buildApp({ config: makeConfig(), store, now: () => FIXED_NOW });
}

describe('GET /healthz', () => {
  it('数据库可达时返回 200', async () => {
    const app = appWith(createFakeStore());
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
    assert.equal(response.json().db, 'ok');
    assert.equal(response.json().time, FIXED_NOW.toISOString());
    await app.close();
  });

  it('数据库不可达时返回 503，而不是崩掉', async () => {
    const store = createFakeStore();
    store.failPing = true;
    const app = appWith(store);
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().status, 'degraded');
    assert.equal(response.json().db, 'error');
    await app.close();
  });
});

describe('POST /v1/auth/login', () => {
  it('用户名 + 正确口令 → 200，签发令牌并落一条会话', async () => {
    const store = storeWithUser();
    const app = appWith(store);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'getl', password: PASSWORD },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.user.username, 'getl');
    assert.equal(body.expiresIn, 900);
    assert.ok(typeof body.refreshToken === 'string' && body.refreshToken.length >= 43);
    assert.equal(body.refreshExpiresAt, new Date(FIXED_NOW.getTime() + 30 * 86_400_000).toISOString());
    // 响应里绝不能出现口令哈希
    assert.ok(!response.body.includes('scrypt$'));

    // access 令牌可用同一密钥验回，且 sid 与落库的会话一致
    const claims = verifyAccessToken(body.accessToken, SECRET, FIXED_NOW);
    assert.ok(claims);
    assert.equal(claims.sub, body.user.id);

    const sessions = [...store.sessions.values()];
    assert.equal(sessions.length, 1);
    assert.equal(claims.sid, sessions[0].id);
    assert.equal(sessions[0].tokenHash, hashRefreshToken(body.refreshToken));
    assert.equal(sessions[0].expiresAt.toISOString(), body.refreshExpiresAt);
    assert.equal(store.lastLogins.length, 1);
    assert.equal(store.lastLogins[0].userId, body.user.id);
    await app.close();
  });

  it('用户名大小写与空格不影响登录', async () => {
    const store = storeWithUser();
    const app = appWith(store);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: '  GetL  ', password: PASSWORD },
    });
    assert.equal(response.statusCode, 200);
    // 归一化之后才查库
    assert.equal(response.json().user.username, 'getl');
    await app.close();
  });

  it('口令错误 → 401 invalid_credentials，且不建会话', async () => {
    const store = storeWithUser();
    const app = appWith(store);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'getl', password: 'wrong horse battery' },
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'invalid_credentials' });
    assert.equal(store.sessions.size, 0);
    assert.equal(store.lastLogins.length, 0);
    await app.close();
  });

  it('用户不存在 → 同样的 401（不泄露用户是否存在）', async () => {
    const store = createFakeStore();
    const app = appWith(store);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'nobody', password: PASSWORD },
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'invalid_credentials' });
    assert.equal(store.sessions.size, 0);
    await app.close();
  });

  it('账号被停用 → 401，即使口令正确', async () => {
    const store = storeWithUser('disabled');
    const app = appWith(store);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'getl', password: PASSWORD },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(store.sessions.size, 0);
    await app.close();
  });

  it('用户名格式非法时不查库（但仍返回 401）', async () => {
    const store = createFakeStore();
    const app = appWith(store);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'a b', password: PASSWORD },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(store.users.size, 0);
    await app.close();
  });

  it('缺字段 → 400；多余字段被忽略（Fastify 默认 removeAdditional）', async () => {
    const store = storeWithUser();
    const app = appWith(store);
    const missing = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'getl' } });
    assert.equal(missing.statusCode, 400);

    const extra = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'getl', password: PASSWORD, isAdmin: true },
    });
    assert.equal(extra.statusCode, 200, '多余字段被剥掉，登录照常成功');
    const body = extra.json();
    assert.equal(body.user.username, 'getl');
    assert.ok(!('isAdmin' in body.user), '响应里不该出现客户端塞进来的额外字段');
    await app.close();
  });

  it('同一用户名连续失败 5 次后，第 6 次直接 429', async () => {
    const store = storeWithUser();
    const app = appWith(store);
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { username: 'getl', password: `wrong-${i}` },
      });
      codes.push(response.statusCode);
    }
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
    await app.close();
  });

  it('登录成功会清掉该用户名的失败计数', async () => {
    const store = storeWithUser();
    const app = appWith(store);
    const fail = () =>
      app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'getl', password: 'nope-nope-nope' } });

    for (let i = 0; i < 4; i += 1) assert.equal((await fail()).statusCode, 401);
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'getl', password: PASSWORD },
    });
    assert.equal(ok.statusCode, 200);
    // 计数已清零：再来 4 次失败仍是 401，而不是 429
    for (let i = 0; i < 4; i += 1) assert.equal((await fail()).statusCode, 401);
    await app.close();
  });
});

describe('LoginRateLimiter', () => {
  it('窗口内限次，窗口过后重新计数', () => {
    const limiter = new LoginRateLimiter(2, 60_000);
    const t0 = new Date('2026-09-10T00:00:00Z');
    assert.equal(limiter.attempt('k', t0), true);
    assert.equal(limiter.attempt('k', t0), true);
    assert.equal(limiter.attempt('k', t0), false);
    const afterWindow = new Date(t0.getTime() + 61_000);
    assert.equal(limiter.attempt('k', afterWindow), true);
  });

  it('reset 后立即恢复', () => {
    const limiter = new LoginRateLimiter(1, 60_000);
    const t0 = new Date('2026-09-10T00:00:00Z');
    assert.equal(limiter.attempt('k', t0), true);
    assert.equal(limiter.attempt('k', t0), false);
    limiter.reset('k');
    assert.equal(limiter.attempt('k', t0), true);
  });
});
