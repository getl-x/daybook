/**
 * 日记接口的路由测试：内存 store + app.inject()，不碰数据库。
 * 覆盖认证失败、今日视图、字段级写入与冲突标记、参数校验、刷新令牌轮转与登出。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildApp } from '../src/app.ts';
import { hashPassword, newSessionId, signAccessToken } from '../src/auth.ts';
import type { Config } from '../src/config.ts';
import { createFakeStore, type FakeStore } from './helpers/fake-store.ts';

const SECRET = 'routes-secret-0123456789abcdef';
const PASSWORD = 'correct horse battery';
/** 2026-09-10 04:00（上海）——刚好跨过日界 */
const NOW = new Date('2026-09-09T20:00:00Z');
const TODAY = '2026-09-10';
const YESTERDAY = '2026-09-09';

const PASSWORD_HASH = await hashPassword(PASSWORD);

const config: Config = {
  nodeEnv: 'test',
  port: 8090,
  databaseUrl: 'postgres://unused:unused@localhost:5432/unused',
  jwtSecret: SECRET,
  logLevel: 'silent',
  vapid: null,
};

interface Ctx {
  store: FakeStore;
  userId: string;
  token: string;
  headers: { authorization: string };
  app: ReturnType<typeof buildApp>;
}

function setup(): Ctx {
  const store = createFakeStore();
  const user = store.addUser({ username: 'getl', passwordHash: PASSWORD_HASH });
  const app = buildApp({ config, store, now: () => NOW });
  // 认证现在会校验"会话仍然有效"（登出/轮转立即生效）→ 令牌对应的会话必须在库里
  const sessionId = newSessionId();
  store.sessions.set(sessionId, {
    id: sessionId,
    userId: user.id,
    expiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
    revokedAt: null,
    tokenHash: 'f'.repeat(64),
    rotatedFrom: null,
  });
  const token = signAccessToken(user.id, sessionId, SECRET, 900, NOW);
  return { store, userId: user.id, token, headers: { authorization: `Bearer ${token}` }, app };
}

describe('认证：受保护接口', () => {
  it('没有令牌 / 令牌乱写 / 账号被停用 → 401', async () => {
    const { store, app, userId } = setup();

    for (const url of ['/v1/meta/today', '/v1/diaries/today', '/v1/diaries/2026-09-10']) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401, `${url} 应要求认证`);
      assert.deepEqual(response.json(), { error: 'unauthorized' });
    }

    const bad = await app.inject({
      method: 'GET',
      url: '/v1/meta/today',
      headers: { authorization: 'Bearer not-a-token' },
    });
    assert.equal(bad.statusCode, 401);

    // 令牌本身合法，但账号被停用 → 立即失效（不用等过期）
    const token = signAccessToken(userId, newSessionId(), SECRET, 900, NOW);
    const user = store.users.get(userId);
    assert.ok(user);
    user.status = 'disabled';
    const disabled = await app.inject({
      method: 'GET',
      url: '/v1/meta/today',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(disabled.statusCode, 401);

    await app.close();
  });
});

describe('GET /v1/meta/today', () => {
  it('返回服务端权威的日记日与设置', async () => {
    const { app, headers, userId } = setup();
    const response = await app.inject({ method: 'GET', url: '/v1/meta/today', headers });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.diary_date, TODAY);
    assert.equal(body.yesterday, YESTERDAY);
    assert.equal(body.timezone, 'Asia/Shanghai');
    assert.equal(body.day_start_hour, 4);
    assert.equal(body.server_time, NOW.toISOString());
    assert.equal(body.user_id, userId);
    await app.close();
  });

  it('时区不同，日记日跟着不同', async () => {
    const { app, headers, userId, store } = setup();
    store.setSettings(userId, { timezone: 'America/New_York', dayStartHour: 4 });

    const response = await app.inject({ method: 'GET', url: '/v1/meta/today', headers });
    // 同一瞬间：纽约是 09-09 16:00 → 日记日仍是 09-09
    assert.equal(response.json().diary_date, YESTERDAY);
    assert.equal(response.json().yesterday, '2026-09-08');
    await app.close();
  });
});

describe('GET /v1/diaries/today 与字段级写入', () => {
  it('还没有记录时返回两条空记录，进度全 false', async () => {
    const { app, headers } = setup();
    const response = await app.inject({ method: 'GET', url: '/v1/diaries/today', headers });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.today.exists, false);
    assert.equal(body.yesterday.exists, false);
    assert.equal(body.today.entryDate, TODAY);
    assert.equal(body.yesterday.entryDate, YESTERDAY);
    assert.deepEqual(body.progress, { morningDone: false, eveningDone: false });
    assert.deepEqual(body.incidents, []);
    await app.close();
  });

  it('写今天的计划 → 只有今天那一行变了；写完昨天的回顾 → 早间才算完成', async () => {
    const { app, headers } = setup();

    const plan = await app.inject({
      method: 'PATCH',
      url: `/v1/diaries/${TODAY}`,
      headers,
      payload: { fields: { day_plan: { value: '写日记核心', base_updated_at: null } } },
    });
    assert.equal(plan.statusCode, 200);
    assert.equal(plan.json().entryDate, TODAY);
    assert.equal(plan.json().version, 1);
    assert.deepEqual(plan.json().fields.day_plan.overwritten, false);

    let view = (await app.inject({ method: 'GET', url: '/v1/diaries/today', headers })).json();
    assert.equal(view.today.fields.day_plan.value, '写日记核心');
    assert.equal(view.today.exists, true);
    assert.equal(view.yesterday.exists, false, '写今天不该顺带建出昨天那一行');
    assert.deepEqual(view.progress, { morningDone: false, eveningDone: false }, '昨天回顾还没写');

    const review = await app.inject({
      method: 'PATCH',
      url: `/v1/diaries/${YESTERDAY}`,
      headers,
      payload: { fields: { day_events: { value: '开会开到吐' } } },
    });
    assert.equal(review.statusCode, 200);

    view = (await app.inject({ method: 'GET', url: '/v1/diaries/today', headers })).json();
    assert.equal(view.yesterday.fields.day_events.value, '开会开到吐');
    assert.deepEqual(view.progress, { morningDone: true, eveningDone: false });

    // 晚间总结 → 晚间完成
    await app.inject({
      method: 'PATCH',
      url: `/v1/diaries/${TODAY}`,
      headers,
      payload: { fields: { evening_summary: { value: '还行' } } },
    });
    view = (await app.inject({ method: 'GET', url: '/v1/diaries/today', headers })).json();
    assert.deepEqual(view.progress, { morningDone: true, eveningDone: true });
    await app.close();
  });

  it('只写变更字段：另一个字段的值与 updatedAt 不受影响', async () => {
    const { app, headers } = setup();
    const first = await app.inject({
      method: 'PATCH',
      url: `/v1/diaries/${TODAY}`,
      headers,
      payload: { fields: { day_plan: { value: '计划 A' } } },
    });
    const planUpdatedAt = first.json().fields.day_plan.updatedAt;

    const second = await app.inject({
      method: 'PATCH',
      url: `/v1/diaries/${TODAY}`,
      headers,
      payload: { fields: { evening_summary: { value: '总结 B' } } },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().version, 2);

    const entry = (await app.inject({ method: 'GET', url: `/v1/diaries/${TODAY}`, headers })).json().entry;
    assert.equal(entry.fields.day_plan.value, '计划 A');
    assert.equal(entry.fields.day_plan.updatedAt, planUpdatedAt);
    assert.equal(entry.fields.evening_summary.value, '总结 B');
    await app.close();
  });

  it('冲突：基准比服务端旧 → 仍然写入但标 overwritten=true', async () => {
    const { app, headers } = setup();
    await app.inject({
      method: 'PATCH',
      url: `/v1/diaries/${TODAY}`,
      headers,
      payload: { fields: { day_plan: { value: '在手机端写的' } } },
    });

    const conflict = await app.inject({
      method: 'PATCH',
      url: `/v1/diaries/${TODAY}`,
      headers,
      payload: {
        fields: { day_plan: { value: '在电脑端用旧版本覆盖', base_updated_at: '2026-09-01T00:00:00.000Z' } },
      },
    });
    assert.equal(conflict.statusCode, 200);
    assert.equal(conflict.json().fields.day_plan.overwritten, true);
    assert.equal(conflict.json().fields.day_plan.value, '在电脑端用旧版本覆盖');
    await app.close();
  });

  it('参数校验：非法字段 / 空 fields / 超长 / 非法日期 / 非法基准时间', async () => {
    const { app, headers } = setup();

    const badField = await app.inject({
      method: 'PATCH',
      url: `/v1/diaries/${TODAY}`,
      headers,
      payload: { fields: { password_hash: { value: 'x' } } },
    });
    assert.equal(badField.statusCode, 400);
    assert.equal(badField.json().error, 'invalid_field');

    const noFields = await app.inject({ method: 'PATCH', url: `/v1/diaries/${TODAY}`, headers, payload: { fields: {} } });
    assert.equal(noFields.statusCode, 400);
    assert.equal(noFields.json().error, 'no_fields');

    const tooLong = await app.inject({
      method: 'PATCH',
      url: `/v1/diaries/${TODAY}`,
      headers,
      payload: { fields: { day_plan: { value: 'x'.repeat(8001) } } },
    });
    assert.equal(tooLong.statusCode, 400);
    assert.equal(tooLong.json().error, 'too_long');

    const badDate = await app.inject({ method: 'GET', url: '/v1/diaries/2026-9-1', headers });
    assert.equal(badDate.statusCode, 400);
    assert.equal(badDate.json().error, 'invalid_date');

    const badBase = await app.inject({
      method: 'PATCH',
      url: `/v1/diaries/${TODAY}`,
      headers,
      payload: { fields: { day_plan: { value: 'x', base_updated_at: '昨天' } } },
    });
    assert.equal(badBase.statusCode, 400);
    assert.equal(badBase.json().error, 'invalid_base_updated_at');
    await app.close();
  });
});

describe('GET /v1/diaries/:date', () => {
  it('有记录返回记录，没记录返回空壳', async () => {
    const { app, headers } = setup();
    await app.inject({
      method: 'PATCH',
      url: '/v1/diaries/2026-08-01',
      headers,
      payload: { fields: { day_events: { value: '补写的回顾' } } },
    });

    const written = await app.inject({ method: 'GET', url: '/v1/diaries/2026-08-01', headers });
    assert.equal(written.statusCode, 200);
    assert.equal(written.json().entry.exists, true);
    assert.equal(written.json().entry.fields.day_events.value, '补写的回顾');

    const empty = await app.inject({ method: 'GET', url: '/v1/diaries/2001-01-01', headers });
    assert.equal(empty.json().entry.exists, false);
    await app.close();
  });
});

describe('刷新令牌轮转与登出', () => {
  it('登录 → 刷新（旧令牌立刻作废）→ 登出', async () => {
    const { app, store } = setup();

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'getl', password: PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    const first = login.json();

    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    assert.equal(refreshed.statusCode, 200);
    const second = refreshed.json();
    assert.notEqual(second.refreshToken, first.refreshToken);
    assert.notEqual(second.accessToken, first.accessToken);
    assert.equal(second.user.username, 'getl');
    // 轮转链：新会话记录它是由哪一个旧会话轮转来的
    assert.equal(typeof second.rotatedFrom, 'string');
    assert.ok(second.rotatedFrom.length > 0);

    // 旧 refresh token 被轮转掉 → 再用就 401
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.json().error, 'invalid_refresh_token');

    // 新令牌还能用，登出后立刻失效
    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { refreshToken: second.refreshToken },
    });
    assert.equal(logout.statusCode, 204);

    const afterLogout = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: second.refreshToken },
    });
    assert.equal(afterLogout.statusCode, 401);
    // setup() 里还有一条没用过的会话；登录与刷新轮转出来的两条都应该已吊销
    const sessions = [...store.sessions.values()];
    assert.equal(sessions.filter((session) => session.revokedAt === null).length, 1, '只剩 setup 那条未使用的会话');
    await app.close();
  });

  it('伪造的 refresh token 被拒', async () => {
    const { app } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: 'x'.repeat(43) },
    });
    assert.equal(response.statusCode, 401);
    await app.close();
  });
});
