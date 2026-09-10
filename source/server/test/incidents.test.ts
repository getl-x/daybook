/**
 * 突发事情与日历的测试：
 *  - 路由层（内存 store + inject）：幂等、跨用户 id 冲突、校验、改时间跨日、删除；
 *  - 存储层（PGlite 真 SQL）：同样语义在真库上的表现 + 日历按月聚合。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildApp } from '../src/app.ts';
import { hashPassword, newSessionId, signAccessToken } from '../src/auth.ts';
import type { Config } from '../src/config.ts';
import { createPgStore } from '../src/db/store.ts';
import { createUser } from '../src/users.ts';
import { createFakeStore } from './helpers/fake-store.ts';
import { createTestDb } from './helpers/pglite.ts';

const SECRET = 'incidents-secret-0123456789abcd';
const PASSWORD = 'correct horse battery';
/** 上海时间 2026-09-10 04:00（刚过日界） */
const NOW = new Date('2026-09-09T20:00:00Z');
const TODAY = '2026-09-10';
const YESTERDAY = '2026-09-09';
const INCIDENT_ID = '33333333-3333-4333-8333-333333333333';

const PASSWORD_HASH = await hashPassword(PASSWORD);

const config: Config = {
  nodeEnv: 'test',
  port: 8090,
  databaseUrl: 'postgres://unused:unused@localhost:5432/unused',
  jwtSecret: SECRET,
  logLevel: 'silent',
  vapid: null,
};

function setup() {
  const store = createFakeStore();
  const alice = store.addUser({ username: 'alice', passwordHash: PASSWORD_HASH });
  const bob = store.addUser({ username: 'bob', passwordHash: PASSWORD_HASH });
  const app = buildApp({ config, store, now: () => NOW });
  // 认证会校验"会话仍然有效"，所以给每个用户都登记一条真实会话
  const headersFor = (userId: string) => {
    const sessionId = newSessionId();
    store.sessions.set(sessionId, {
      id: sessionId,
      userId,
      expiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
      revokedAt: null,
      tokenHash: 'f'.repeat(64),
      rotatedFrom: null,
    });
    return { authorization: `Bearer ${signAccessToken(userId, sessionId, SECRET, 900, NOW)}` };
  };
  return { store, alice, bob, app, aliceHeaders: headersFor(alice.id), bobHeaders: headersFor(bob.id) };
}

describe('POST /v1/incidents（路由）', () => {
  it('创建 → 201，归属日由 occurred_at + 时区 + 日界算出', async () => {
    const { app, aliceHeaders } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers: aliceHeaders,
      payload: { id: INCIDENT_ID, content: '  开会时想到一个点子  ', occurred_at: '2026-09-10T02:00:00Z', tag: 'idea' },
    });

    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.created, true);
    assert.equal(body.incident.id, INCIDENT_ID);
    assert.equal(body.incident.content, '开会时想到一个点子', '首尾空白应被去掉');
    assert.equal(body.incident.tag, 'idea');
    assert.equal(body.incident.entryDate, TODAY);
    await app.close();
  });

  it('归属日按用户时区/日界算：上海 03:00 写的内容归前一天', async () => {
    const { app, aliceHeaders } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers: aliceHeaders,
      // 上海本地 2026-09-10 03:00 → 还在 09-09 的日记日里
      payload: { id: INCIDENT_ID, content: '凌晨想到的', occurred_at: '2026-09-09T19:00:00Z' },
    });
    assert.equal(response.json().incident.entryDate, YESTERDAY);
    await app.close();
  });

  it('不带 occurred_at 时用服务端当前时间', async () => {
    const { app, aliceHeaders } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers: aliceHeaders,
      payload: { id: INCIDENT_ID, content: '随手记' },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().incident.occurredAt, NOW.toISOString());
    assert.equal(response.json().incident.entryDate, TODAY);
    await app.close();
  });

  it('重复提交同一个 id 是幂等的：200 + created:false，不产生第二条', async () => {
    const { app, store, aliceHeaders } = setup();
    const payload = { id: INCIDENT_ID, content: '只应存在一条' };

    const first = await app.inject({ method: 'POST', url: '/v1/incidents', headers: aliceHeaders, payload });
    assert.equal(first.statusCode, 201);

    const replay = await app.inject({ method: 'POST', url: '/v1/incidents', headers: aliceHeaders, payload });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().created, false);
    assert.equal(replay.json().incident.content, '只应存在一条');
    assert.equal(store.incidents.size, 1);
    await app.close();
  });

  it('同一个 id 被别的用户占用 → 409（客户端 UUID 撞车）', async () => {
    const { app, aliceHeaders, bobHeaders } = setup();
    await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers: aliceHeaders,
      payload: { id: INCIDENT_ID, content: 'alice 的' },
    });

    const bob = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers: bobHeaders,
      payload: { id: INCIDENT_ID, content: 'bob 的' },
    });
    assert.equal(bob.statusCode, 409);
    assert.equal(bob.json().error, 'id_conflict');
    await app.close();
  });

  it('参数校验：id 非 UUID / content 空 / 太长 / 时间非法 / 标签不在白名单', async () => {
    const { app, aliceHeaders } = setup();
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/v1/incidents', headers: aliceHeaders, payload });

    assert.equal((await post({ id: 'not-a-uuid', content: 'x' })).statusCode, 400);
    assert.equal((await post({ id: INCIDENT_ID, content: '   ' })).json().error, 'invalid_field');
    assert.equal((await post({ id: INCIDENT_ID, content: 'x'.repeat(2001) })).json().error, 'too_long');
    assert.equal((await post({ id: INCIDENT_ID, content: 'x', occurred_at: '昨天' })).json().error, 'invalid_field');
    assert.equal((await post({ id: INCIDENT_ID, content: 'x', tag: 'nope' })).json().error, 'invalid_field');
    // 不带标签 → 默认 other
    assert.equal((await post({ id: INCIDENT_ID, content: 'x' })).json().incident.tag, 'other');
    await app.close();
  });

  it('无令牌 → 401', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'POST', url: '/v1/incidents', payload: { id: INCIDENT_ID, content: 'x' } });
    assert.equal(response.statusCode, 401);
    await app.close();
  });
});

describe('GET / PATCH / DELETE /v1/incidents（路由）', () => {
  it('列表：只返回当天、按发生时间排序', async () => {
    const { app, aliceHeaders } = setup();
    for (const [id, content, occurredAt] of [
      ['44444444-4444-4444-8444-444444444444', '下午的', '2026-09-10T06:00:00Z'],
      ['55555555-5555-4555-8555-555555555555', '早上的', '2026-09-10T01:00:00Z'],
      ['66666666-6666-4666-8666-666666666666', '昨天的', '2026-09-09T01:00:00Z'],
    ] as const) {
      await app.inject({
        method: 'POST',
        url: '/v1/incidents',
        headers: aliceHeaders,
        payload: { id, content, occurred_at: occurredAt },
      });
    }

    const list = await app.inject({ method: 'GET', url: `/v1/incidents?date=${TODAY}`, headers: aliceHeaders });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(
      list.json().incidents.map((incident: { content: string }) => incident.content),
      ['早上的', '下午的'],
    );

    const missing = await app.inject({ method: 'GET', url: '/v1/incidents', headers: aliceHeaders });
    assert.equal(missing.statusCode, 400);
    await app.close();
  });

  it('改内容 / 改时间跨日（归属日跟着变）/ 清掉标签 / 无改动报 400', async () => {
    const { app, aliceHeaders } = setup();
    await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers: aliceHeaders,
      payload: { id: INCIDENT_ID, content: '原始内容', occurred_at: '2026-09-10T02:00:00Z', tag: 'work' },
    });

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/v1/incidents/${INCIDENT_ID}`,
      headers: aliceHeaders,
      payload: { content: '改过的内容' },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().incident.content, '改过的内容');
    assert.equal(renamed.json().incident.entryDate, TODAY);

    // 把时间改到昨天 → 归属日变成昨天
    const moved = await app.inject({
      method: 'PATCH',
      url: `/v1/incidents/${INCIDENT_ID}`,
      headers: aliceHeaders,
      payload: { occurred_at: '2026-09-09T02:00:00Z' },
    });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().incident.entryDate, YESTERDAY);

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/v1/incidents/${INCIDENT_ID}`,
      headers: aliceHeaders,
      payload: { tag: null },
    });
    assert.equal(cleared.json().incident.tag, null);

    const empty = await app.inject({
      method: 'PATCH',
      url: `/v1/incidents/${INCIDENT_ID}`,
      headers: aliceHeaders,
      payload: {},
    });
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().error, 'no_changes');

    // 改时间也改内容：两个字段一起生效
    const both = await app.inject({
      method: 'PATCH',
      url: `/v1/incidents/${INCIDENT_ID}`,
      headers: aliceHeaders,
      payload: { content: '两个字段', occurred_at: '2026-09-10T05:00:00Z', tag: 'life' },
    });
    assert.equal(both.json().incident.content, '两个字段');
    assert.equal(both.json().incident.tag, 'life');
    assert.equal(both.json().incident.entryDate, TODAY);
    await app.close();
  });

  it('改/删别人的记录 → 404；非法 id → 400；删两次 → 第二次 404', async () => {
    const { app, aliceHeaders, bobHeaders } = setup();
    await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers: aliceHeaders,
      payload: { id: INCIDENT_ID, content: 'alice 的' },
    });

    const bobPatch = await app.inject({
      method: 'PATCH',
      url: `/v1/incidents/${INCIDENT_ID}`,
      headers: bobHeaders,
      payload: { content: 'bob 想改' },
    });
    assert.equal(bobPatch.statusCode, 404);

    const bobDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/incidents/${INCIDENT_ID}`,
      headers: bobHeaders,
    });
    assert.equal(bobDelete.statusCode, 404);

    const badId = await app.inject({
      method: 'DELETE',
      url: '/v1/incidents/not-a-uuid',
      headers: aliceHeaders,
    });
    assert.equal(badId.statusCode, 400);

    const first = await app.inject({
      method: 'DELETE',
      url: `/v1/incidents/${INCIDENT_ID}`,
      headers: aliceHeaders,
    });
    assert.equal(first.statusCode, 204);

    const second = await app.inject({
      method: 'DELETE',
      url: `/v1/incidents/${INCIDENT_ID}`,
      headers: aliceHeaders,
    });
    assert.equal(second.statusCode, 404);
    await app.close();
  });
});

describe('GET /v1/calendar（路由）', () => {
  it('返回当月有记录的日期；月份参数缺失或格式错 → 400', async () => {
    const { app, aliceHeaders } = setup();
    await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers: aliceHeaders,
      payload: { id: INCIDENT_ID, content: '有突发的一天', occurred_at: '2026-09-10T02:00:00Z' },
    });
    await app.inject({
      method: 'PATCH',
      url: '/v1/diaries/2026-09-05',
      headers: aliceHeaders,
      payload: { fields: { day_plan: { value: '有正文的一天' } } },
    });

    const calendar = await app.inject({ method: 'GET', url: '/v1/calendar?month=2026-09', headers: aliceHeaders });
    assert.equal(calendar.statusCode, 200);
    assert.deepEqual(calendar.json().days, [
      { date: '2026-09-05', hasContent: true, incidentCount: 0 },
      { date: '2026-09-10', hasContent: false, incidentCount: 1 },
    ]);

    assert.equal((await app.inject({ method: 'GET', url: '/v1/calendar', headers: aliceHeaders })).statusCode, 400);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/v1/calendar?month=2026-13', headers: aliceHeaders })).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/v1/calendar?month=2026-9', headers: aliceHeaders })).statusCode,
      400,
    );
    await app.close();
  });
});

describe('突发事情与日历（真实 SQL）', () => {
  async function sqlSetup() {
    const db = await createTestDb();
    const store = createPgStore(db);
    const alice = await createUser(db, { username: 'alice', password: PASSWORD });
    const bob = await createUser(db, { username: 'bob', password: PASSWORD });
    return { db, store, alice, bob };
  }

  it('按 id 幂等；别人的 id → null', async () => {
    const { db, store, alice, bob } = await sqlSetup();
    const input = {
      id: INCIDENT_ID,
      entryDate: TODAY,
      occurredAt: '2026-09-10T02:00:00.000Z',
      content: '只应存在一条',
      tag: 'work',
    };

    const first = await store.createIncident(alice.id, input);
    assert.equal(first?.created, true);

    const replay = await store.createIncident(alice.id, input);
    assert.equal(replay?.created, false);
    assert.equal(replay?.incident.content, '只应存在一条');

    const clash = await store.createIncident(bob.id, input);
    assert.equal(clash, null, 'id 被 alice 占了 → bob 拿到 null（路由映射 409）');

    const { rows } = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM incidents');
    assert.equal(rows[0]?.count, 1);
    await db.close();
  });

  it('改内容/时间/归属日/标签，且只影响本人的行', async () => {
    const { db, store, alice, bob } = await sqlSetup();
    await store.createIncident(alice.id, {
      id: INCIDENT_ID,
      entryDate: TODAY,
      occurredAt: '2026-09-10T02:00:00.000Z',
      content: '原始',
      tag: 'work',
    });

    const moved = await store.updateIncident(alice.id, INCIDENT_ID, {
      content: '改过',
      occurredAt: '2026-09-09T02:00:00.000Z',
      entryDate: YESTERDAY,
      tag: null,
    });
    assert.equal(moved?.content, '改过');
    assert.equal(moved?.entryDate, YESTERDAY);
    assert.equal(moved?.tag, null);

    assert.equal(await store.updateIncident(bob.id, INCIDENT_ID, { content: 'bob 改' }), null);
    assert.equal(await store.deleteIncident(bob.id, INCIDENT_ID), false);
    assert.equal(await store.deleteIncident(alice.id, INCIDENT_ID), true);
    assert.equal(await store.deleteIncident(alice.id, INCIDENT_ID), false);
    await db.close();
  });

  it('日历：正文日期、突发日期、两者都有的日期都会出现，且不含别人的数据', async () => {
    const { db, store, alice, bob } = await sqlSetup();

    // alice：09-05 只有正文；09-10 只有两条突发；09-11 两者都有
    await store.upsertDiaryFields(alice.id, '2026-09-05', [{ field: 'day_plan', value: '计划', baseUpdatedAt: null }], new Date());
    await store.upsertDiaryFields(alice.id, '2026-09-11', [{ field: 'day_events', value: '事件', baseUpdatedAt: null }], new Date());
    await store.createIncident(alice.id, { id: '77777777-7777-4777-8777-777777777777', entryDate: TODAY, occurredAt: '2026-09-10T01:00:00Z', content: 'a', tag: null });
    await store.createIncident(alice.id, { id: '88888888-8888-4888-8888-888888888888', entryDate: TODAY, occurredAt: '2026-09-10T02:00:00Z', content: 'b', tag: null });
    await store.createIncident(alice.id, { id: '99999999-9999-4999-8999-999999999999', entryDate: '2026-09-11', occurredAt: '2026-09-11T01:00:00Z', content: 'c', tag: null });
    // bob：同月但与他无关
    await store.createIncident(bob.id, { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', entryDate: TODAY, occurredAt: '2026-09-10T03:00:00Z', content: 'bob 的', tag: null });

    const days = await store.listEntryDates(alice.id, '2026-09-01', '2026-10-01');
    assert.deepEqual(days, [
      { date: '2026-09-05', hasContent: true, incidentCount: 0 },
      { date: '2026-09-10', hasContent: false, incidentCount: 2 },
      { date: '2026-09-11', hasContent: true, incidentCount: 1 },
    ]);

    // 月份左闭右开：下个月的记录不出现
    const nextMonth = await store.listEntryDates(alice.id, '2026-10-01', '2026-11-01');
    assert.deepEqual(nextMonth, []);
    await db.close();
  });
});
