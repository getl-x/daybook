/**
 * 设置与通知接口的测试：
 *  - 路由层（内存 store + inject）：参数校验、自愈排程、订阅 upsert/删除、状态查询；
 *  - 存储层（PGlite 真 SQL）：提醒设置读写、排程、送达幂等、订阅 upsert 与失效处理。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildApp } from '../src/app.ts';
import { hashPassword, newSessionId, signAccessToken } from '../src/auth.ts';
import type { Config } from '../src/config.ts';
import { createNotificationStore } from '../src/db/notification-store.ts';
import { createPgStore } from '../src/db/store.ts';
import type { AppStore } from '../src/app.ts';
import type { NotificationStore } from '../src/notifications.ts';
import { createUser } from '../src/users.ts';
import { createFakeStore } from './helpers/fake-store.ts';
import { createTestDb } from './helpers/pglite.ts';

const SECRET = 'notifications-secret-0123456789';
const PASSWORD = 'correct horse battery';
/** 上海时间 2026-09-10 09:00 */
const NOW = new Date('2026-09-10T01:00:00Z');
const ENDPOINT = 'https://push.example/device-1';

const PASSWORD_HASH = await hashPassword(PASSWORD);

const config: Config = {
  nodeEnv: 'test',
  port: 8090,
  databaseUrl: 'postgres://unused:unused@localhost:5432/unused',
  jwtSecret: SECRET,
  logLevel: 'silent',
  vapid: null, // 测试里不配 VAPID：正好覆盖"没配置"的分支
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

const validSubscription = {
  endpoint: ENDPOINT,
  keys: { p256dh: 'p256dh-key-value', auth: 'auth-key-value' },
};

describe('GET /v1/settings', () => {
  it('返回提醒设置与推送状态，并顺手补上排程（自愈）', async () => {
    const { app, store, alice, aliceHeaders } = setup();
    assert.equal(store.schedules.size, 0);

    const response = await app.inject({ method: 'GET', url: '/v1/settings', headers: aliceHeaders });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.timezone, 'Asia/Shanghai');
    assert.equal(body.day_start_hour, 4);
    assert.deepEqual(body.reminders, {
      morning_enabled: true,
      morning_time: '09:00',
      evening_enabled: true,
      evening_time: '21:00',
      only_if_incomplete: true,
    });
    assert.equal(body.push.vapid_public_key, null, '测试环境没配 VAPID');
    assert.equal(body.push.subscriptions, 0);

    // 自愈：两种提醒的排程都被建出来了，且都晚于 now
    assert.equal(store.schedules.size, 2);
    assert.equal(store.schedules.get(`${alice.id}:morning`)?.toISOString(), '2026-09-11T01:00:00.000Z');
    assert.equal(store.schedules.get(`${alice.id}:evening`)?.toISOString(), '2026-09-10T13:00:00.000Z');
    await app.close();
  });

  it('没令牌 → 401', async () => {
    const { app } = setup();
    assert.equal((await app.inject({ method: 'GET', url: '/v1/settings' })).statusCode, 401);
    await app.close();
  });
});

describe('PATCH /v1/settings', () => {
  it('改提醒时间会立刻重算排程', async () => {
    const { app, store, alice, aliceHeaders } = setup();
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/settings',
      headers: aliceHeaders,
      payload: { reminder_morning_time: '07:15', reminder_evening_enabled: false },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reminders.morning_time, '07:15');
    assert.equal(response.json().reminders.evening_enabled, false);
    // 07:15 已经过了（now 是 09:00）→ 下一次是次日 07:15 上海 = 09-10T23:15Z
    assert.equal(store.schedules.get(`${alice.id}:morning`)?.toISOString(), '2026-09-10T23:15:00.000Z');
    assert.equal(store.schedules.get(`${alice.id}:evening`), null, '关掉的提醒排程置空');
    await app.close();
  });

  it('改时区也会重算排程', async () => {
    const { app, store, alice, aliceHeaders } = setup();
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/settings',
      headers: aliceHeaders,
      payload: { timezone: 'America/New_York', day_start_hour: 0 },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().timezone, 'America/New_York');
    // 纽约 09:00（EDT, UTC-4）→ 13:00Z
    assert.equal(store.schedules.get(`${alice.id}:morning`)?.toISOString(), '2026-09-10T13:00:00.000Z');
    await app.close();
  });

  it('参数校验：非法时区 / 非法时间 / 非法日界 / 没有可改字段', async () => {
    const { app, aliceHeaders } = setup();
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: '/v1/settings', headers: aliceHeaders, payload });

    assert.equal((await patch({ timezone: 'Shanghai' })).statusCode, 400);
    assert.equal((await patch({ reminder_morning_time: '25:00' })).statusCode, 400);
    assert.equal((await patch({ reminder_evening_time: '9:00' })).statusCode, 400);
    assert.equal((await patch({ day_start_hour: 9 })).statusCode, 400);
    const none = await patch({});
    assert.equal(none.statusCode, 400);
    assert.equal(none.json().error, 'no_changes');
    await app.close();
  });
});

describe('推送订阅接口', () => {
  it('订阅成功：返回订阅 id，重复上报同一 endpoint 不产生第二条', async () => {
    const { app, store, aliceHeaders } = setup();

    const first = await app.inject({
      method: 'POST',
      url: '/v1/notifications/subscriptions',
      headers: aliceHeaders,
      payload: validSubscription,
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().settings.push.subscriptions, 1);
    assert.ok(typeof first.json().subscription.id === 'string');

    const again = await app.inject({
      method: 'POST',
      url: '/v1/notifications/subscriptions',
      headers: aliceHeaders,
      payload: validSubscription,
    });
    assert.equal(again.json().settings.push.subscriptions, 1, '同 endpoint 只算一台设备');
    assert.equal(store.pushSubscriptions.size, 1);
    await app.close();
  });

  it('参数校验：endpoint 必须是 https，keys 必填', async () => {
    const { app, aliceHeaders } = setup();
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/v1/notifications/subscriptions', headers: aliceHeaders, payload });

    assert.equal((await post({ endpoint: 'http://push.example/x', keys: validSubscription.keys })).statusCode, 400);
    assert.equal((await post({ endpoint: ENDPOINT })).statusCode, 400);
    assert.equal((await post({ endpoint: ENDPOINT, keys: { p256dh: 'x', auth: '' } })).statusCode, 400);
    await app.close();
  });

  it('删除订阅：本人 204，重复删 / 删别人的 → 404', async () => {
    const { app, aliceHeaders, bobHeaders } = setup();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/notifications/subscriptions',
      headers: aliceHeaders,
      payload: validSubscription,
    });
    const id = created.json().subscription.id as string;

    assert.equal(
      (await app.inject({ method: 'DELETE', url: `/v1/notifications/subscriptions/${id}`, headers: bobHeaders }))
        .statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: 'DELETE', url: `/v1/notifications/subscriptions/${id}`, headers: aliceHeaders }))
        .statusCode,
      204,
    );
    assert.equal(
      (await app.inject({ method: 'DELETE', url: `/v1/notifications/subscriptions/${id}`, headers: aliceHeaders }))
        .statusCode,
      404,
    );
    await app.close();
  });

  it('GET /v1/notifications/status 报告订阅数、最近送达与 VAPID 缺失', async () => {
    const { app, aliceHeaders } = setup();
    await app.inject({
      method: 'POST',
      url: '/v1/notifications/subscriptions',
      headers: aliceHeaders,
      payload: validSubscription,
    });

    const status = await app.inject({ method: 'GET', url: '/v1/notifications/status', headers: aliceHeaders });
    assert.equal(status.statusCode, 200);
    const body = status.json();
    assert.equal(body.vapid_public_key, null);
    assert.equal(body.push_configured, false);
    assert.equal(body.subscriptions.length, 1);
    assert.equal(body.subscriptions[0].failure_count, 0);
    assert.deepEqual(body.recent_deliveries, []);
    assert.equal(body.reminders.morning_time, '09:00');
    await app.close();
  });

  it('GET /v1/meta/timezones 需要登录，登录后返回 IANA 列表', async () => {
    const { app, aliceHeaders } = setup();

    const anonymous = await app.inject({ method: 'GET', url: '/v1/meta/timezones' });
    assert.equal(anonymous.statusCode, 401);

    const response = await app.inject({ method: 'GET', url: '/v1/meta/timezones', headers: aliceHeaders });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().timezones.includes('Asia/Shanghai'));
    await app.close();
  });
});

describe('提醒与订阅的存储层（真实 SQL）', () => {
  async function sqlSetup() {
    const db = await createTestDb();
    const store: AppStore & NotificationStore = { ...createPgStore(db), ...createNotificationStore(db) };
    const alice = await createUser(db, { username: 'alice', password: PASSWORD });
    const bob = await createUser(db, { username: 'bob', password: PASSWORD });
    return { db, store, alice, bob };
  }

  it('提醒设置：默认值正确（时间是 HH:MM），局部更新只改传进来的字段', async () => {
    const { db, store, alice } = await sqlSetup();

    const initial = await store.getReminderSettings(alice.id);
    assert.equal(initial.morningReminderTime, '09:00', 'time 列要走 to_char 才不会带秒');
    assert.equal(initial.eveningReminderTime, '21:00');
    assert.equal(initial.notifyOnlyIfIncomplete, true);
    assert.equal(initial.timezone, 'Asia/Shanghai');

    const updated = await store.updateReminderSettings(alice.id, { morningReminderTime: '06:45', timezone: 'Asia/Tokyo' });
    assert.equal(updated.morningReminderTime, '06:45');
    assert.equal(updated.timezone, 'Asia/Tokyo');
    assert.equal(updated.eveningReminderTime, '21:00', '没传的字段不动');
    await db.close();
  });

  it('排程：upsert 覆盖同一行，listDueSchedules 只取到期的并按时间排序', async () => {
    const { db, store, alice } = await sqlSetup();
    const t1 = new Date('2026-09-10T01:00:00Z');
    const t2 = new Date('2026-09-11T01:00:00Z');

    await store.setSchedule(alice.id, 'morning', t2);
    await store.setSchedule(alice.id, 'evening', t1);
    await store.setSchedule(alice.id, 'evening', t1); // 幂等覆盖

    const due = await store.listDueSchedules(new Date('2026-09-10T02:00:00Z'), 10);
    assert.deepEqual(
      due.map((row) => [row.userId, row.kind]),
      [[alice.id, 'evening']],
    );

    const later = await store.listDueSchedules(new Date('2026-09-12T00:00:00Z'), 10);
    assert.equal(later.length, 2);
    assert.equal(later[0]?.kind, 'evening', '按触发时间排序');

    await store.setSchedule(alice.id, 'evening', null);
    const afterDisable = await store.listDueSchedules(new Date('2026-09-12T00:00:00Z'), 10);
    assert.deepEqual(afterDisable.map((row) => row.kind), ['morning']);
    await db.close();
  });

  it('送达记录：幂等占位 + 状态回写 + attempts 累加', async () => {
    const { db, store, alice } = await sqlSetup();

    assert.equal(await store.beginDelivery(alice.id, '2026-09-10', 'morning'), true);
    assert.equal(await store.beginDelivery(alice.id, '2026-09-10', 'morning'), false, '第二次是重放');

    assert.deepEqual(await store.getDelivery(alice.id, '2026-09-10', 'morning'), {
      status: 'pending',
      attempts: 0,
      lastError: null,
    });

    await store.finishDelivery(alice.id, '2026-09-10', 'morning', 'failed', 'HTTP 500');
    const failed = await store.getDelivery(alice.id, '2026-09-10', 'morning');
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.attempts, 1);
    assert.equal(failed?.lastError, 'HTTP 500');

    await store.finishDelivery(alice.id, '2026-09-10', 'morning', 'sent');
    const sent = await store.getDelivery(alice.id, '2026-09-10', 'morning');
    assert.equal(sent?.status, 'sent');
    assert.equal(sent?.attempts, 2);

    const list = await store.listReminderDeliveries(alice.id, 5);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.localDate, '2026-09-10');
    await db.close();
  });

  it('订阅：同 endpoint upsert 不重复、可转移账号、失效后重新订阅会复活', async () => {
    const { db, store, alice, bob } = await sqlSetup();
    const input = { endpoint: ENDPOINT, p256dh: 'p1', auth: 'a1', userAgent: 'ua' };

    const first = await store.upsertPushSubscription(alice.id, input);
    const second = await store.upsertPushSubscription(alice.id, { ...input, p256dh: 'p2' });
    assert.equal(first.id, second.id, '同 endpoint 是同一行');
    assert.equal((await store.listPushSubscriptions(alice.id))[0]?.p256dh, 'p2');

    // 同一浏览器换账号 → 订阅转到新账号名下
    const moved = await store.upsertPushSubscription(bob.id, input);
    assert.equal(moved.id, first.id);
    assert.deepEqual(await store.listPushSubscriptions(alice.id), []);
    assert.equal((await store.listPushSubscriptions(bob.id)).length, 1);

    // 失效 → 禁用 → 重新订阅会复活并清零计数
    await store.recordPushResult(first.id, 'gone', new Date('2026-09-10T02:00:00Z'));
    assert.deepEqual(await store.listPushSubscriptions(bob.id), [], '失效后不再出现在可用列表');
    const revived = await store.upsertPushSubscription(bob.id, input);
    assert.equal(revived.disabledAt, null);
    assert.equal(revived.failureCount, 0);
    await db.close();
  });

  it('订阅失败计数：sent 清零、连续失败到阈值自动禁用', async () => {
    const { db, store, alice } = await sqlSetup();
    const subscription = await store.upsertPushSubscription(alice.id, {
      endpoint: ENDPOINT,
      p256dh: 'p1',
      auth: 'a1',
    });
    const at = new Date('2026-09-10T02:00:00Z');

    await store.recordPushResult(subscription.id, 'failed', at);
    await store.recordPushResult(subscription.id, 'failed', at);
    assert.equal((await store.listPushSubscriptions(alice.id))[0]?.failureCount, 2);

    await store.recordPushResult(subscription.id, 'sent', at);
    assert.equal((await store.listPushSubscriptions(alice.id))[0]?.failureCount, 0, '成功一次就清零');

    for (let index = 0; index < 10; index += 1) {
      await store.recordPushResult(subscription.id, 'failed', at);
    }
    assert.deepEqual(await store.listPushSubscriptions(alice.id), [], '连续失败到阈值后自动禁用');
    await db.close();
  });

  it('删除订阅只影响本人', async () => {
    const { db, store, alice, bob } = await sqlSetup();
    const subscription = await store.upsertPushSubscription(alice.id, {
      endpoint: ENDPOINT,
      p256dh: 'p1',
      auth: 'a1',
    });
    assert.equal(await store.deletePushSubscription(bob.id, subscription.id), false);
    assert.equal(await store.deletePushSubscription(alice.id, subscription.id), true);
    assert.equal(await store.deletePushSubscription(alice.id, subscription.id), false);
    await db.close();
  });
});
