/**
 * 代码审查后的修复回归测试（对照安全/正确性审查发现的问题）：
 *  1. 时区必须真校验（`Asia/Beijing` 这类不存在的名字不能落库）；
 *  2. 调度器里单个用户的脏数据不能让整个 tick 中断；
 *  3. 登出/轮转后，尚未过期的 access token 立刻失效；
 *  4. 日期必须是真实日历日、occurred_at 有合理范围（不能变成 500）；
 *  5. 5xx 只回 internal_error（不回数据库原文）；
 *  6. 账号删除：要口令确认、立刻吊销会话与订阅、宽限期过后被清除；
 *  7. /v1/meta/timezones 需要登录。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp, type AppStore } from '../src/app.ts';
import { hashPassword, signAccessToken } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import type { Db } from '../src/db/db.ts';
import { createNotificationStore } from '../src/db/notification-store.ts';
import { createPgStore } from '../src/db/store.ts';
import type { NotificationStore, PushSubscriptionRecord, ReminderKind } from '../src/notifications.ts';
import { runDueReminders, type SchedulerDeps } from '../src/scheduler.ts';
import { createUser, purgeExpiredAccounts, purgeUser } from '../src/users.ts';
import { createFakeStore, type FakeStore } from './helpers/fake-store.ts';
import { createTestDb } from './helpers/pglite.ts';

/* --------------------- 接口层（内存 store，注入固定时间） --------------------- */

const SECRET = 'test-secret-at-least-32-characters-long!!';
const PASSWORD = 'daybook-test-2026';
const AT = new Date('2026-09-10T04:30:00Z');

type CombinedStore = AppStore & NotificationStore;

function buildTestApp(store: CombinedStore, at: Date = AT): FastifyInstance {
  return buildApp({
    config: loadConfig({
      DATABASE_URL: 'postgres://test/test',
      JWT_SECRET: SECRET,
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
    }),
    store,
    now: () => at,
  });
}

interface Seeded {
  userId: string;
  sessionId: string;
  token: string;
}

async function seedUser(store: FakeStore, username = 'getl'): Promise<Seeded> {
  const passwordHash = await hashPassword(PASSWORD);
  const user = store.addUser({ username, passwordHash, status: 'active' });
  const sessionId = '11111111-2222-4333-8444-555555555555';
  store.sessions.set(sessionId, {
    id: sessionId,
    userId: user.id,
    expiresAt: new Date(AT.getTime() + 30 * 24 * 60 * 60 * 1000),
    revokedAt: null,
    tokenHash: 'a'.repeat(64),
    rotatedFrom: null,
  });
  return { userId: user.id, sessionId, token: signAccessToken(user.id, sessionId, SECRET, 900, AT) };
}

describe('审查修复：接口层', () => {
  it('未登录不能读时区列表，登录后可以', async () => {
    const store = createFakeStore();
    const app = buildTestApp(store);

    const anonymous = await app.inject({ method: 'GET', url: '/v1/meta/timezones' });
    assert.equal(anonymous.statusCode, 401);

    const { token } = await seedUser(store);
    const authorized = await app.inject({
      method: 'GET',
      url: '/v1/meta/timezones',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(authorized.statusCode, 200);
    assert.ok(Array.isArray(authorized.json().timezones));
    await app.close();
  });

  it('不存在的时区（Asia/Beijing）被 400 拒绝，不会落库', async () => {
    const store = createFakeStore();
    const app = buildTestApp(store);
    const { token } = await seedUser(store);

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { timezone: 'Asia/Beijing' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_field');

    const afterwards = await app.inject({
      method: 'GET',
      url: '/v1/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(afterwards.json().timezone, 'Asia/Shanghai', '时区没有被写坏');
    await app.close();
  });

  it('合法时区照常写入', async () => {
    const store = createFakeStore();
    const app = buildTestApp(store);
    const { token } = await seedUser(store);

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { timezone: 'Europe/Berlin' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().timezone, 'Europe/Berlin');
    await app.close();
  });

  it('day_start_hour 只接受 0–6 的整数（true / 1.5 / 9 / 负数 都被拒）', async () => {
    const store = createFakeStore();
    const app = buildTestApp(store);
    const { token } = await seedUser(store);

    for (const value of [true, 1.5, 9, -1, '四']) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/v1/settings',
        headers: { authorization: `Bearer ${token}` },
        payload: { day_start_hour: value },
      });
      assert.equal(response.statusCode, 400, `day_start_hour=${String(value)} 应该被拒`);
    }
    await app.close();
  });

  it('会话被吊销后，未过期的 access token 立刻失效', async () => {
    const store = createFakeStore();
    const app = buildTestApp(store);
    const { token, sessionId } = await seedUser(store);

    const before = await app.inject({
      method: 'GET',
      url: '/v1/diaries/today',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(before.statusCode, 200);

    await store.revokeSession(sessionId, AT);

    const afterwards = await app.inject({
      method: 'GET',
      url: '/v1/diaries/today',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(afterwards.statusCode, 401);
    await app.close();
  });

  it('停用账号后令牌立刻失效', async () => {
    const store = createFakeStore();
    const app = buildTestApp(store);
    const { token, userId } = await seedUser(store);
    const user = store.users.get(userId);
    assert.ok(user);
    user.status = 'disabled';

    const response = await app.inject({
      method: 'GET',
      url: '/v1/diaries/today',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 401);
    await app.close();
  });

  it('不存在的日历日（2026-02-31 / 2026-13-01）返 400 而不是 500', async () => {
    const store = createFakeStore();
    const app = buildTestApp(store);
    const { token } = await seedUser(store);

    for (const date of ['2026-02-31', '2026-13-01', '0000-01-01']) {
      const get = await app.inject({
        method: 'GET',
        url: `/v1/diaries/${date}`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(get.statusCode, 400, `GET ${date}`);

      const patch = await app.inject({
        method: 'PATCH',
        url: `/v1/diaries/${date}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { fields: { day_events: { value: 'x' } } },
      });
      assert.equal(patch.statusCode, 400, `PATCH ${date}`);

      const incidents = await app.inject({
        method: 'GET',
        url: `/v1/incidents?date=${date}`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(incidents.statusCode, 400, `GET incidents ${date}`);
    }
    await app.close();
  });

  it('极端的 occurred_at 返 400（不会写出畸形归属日）', async () => {
    const store = createFakeStore();
    const app = buildTestApp(store);
    const { token } = await seedUser(store);

    for (const occurredAt of ['0001-01-01T00:00:00.000Z', '275760-09-13T00:00:00.000Z']) {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/incidents',
        headers: { authorization: `Bearer ${token}` },
        payload: { id: '11111111-1111-4111-8111-111111111111', content: '时间离谱', occurred_at: occurredAt },
      });
      assert.equal(created.statusCode, 400, occurredAt);
    }

    const patched = await app.inject({
      method: 'PATCH',
      url: '/v1/incidents/11111111-1111-4111-8111-111111111111',
      headers: { authorization: `Bearer ${token}` },
      payload: { occurred_at: '0001-01-01T00:00:00.000Z' },
    });
    assert.equal(patched.statusCode, 400);
    await app.close();
  });

  it('内部错误只回 internal_error（不回数据库原文）', async () => {
    const store = createFakeStore();
    const failing: CombinedStore = {
      ...store,
      getDiaryEntry: async () => {
        throw new Error('relation "daily_entries" does not exist at character 42');
      },
    };
    const app = buildTestApp(failing);
    const { token } = await seedUser(store);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/diaries/2026-09-10',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: 'internal_error' });
    assert.equal(response.body.includes('daily_entries'), false);
    await app.close();
  });

  it('删除账号：缺口令 400、口令错 401 且状态不变', async () => {
    const store = createFakeStore();
    const app = buildTestApp(store);
    const { token, userId } = await seedUser(store);

    const missing = await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    assert.equal(missing.statusCode, 400);

    const wrong = await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'not-the-password' },
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(store.users.get(userId)?.status, 'active');
    await app.close();
  });

  it('删除账号：口令正确 → pending_deletion、会话吊销、订阅清空、令牌立刻失效', async () => {
    const store = createFakeStore();
    const app = buildTestApp(store);
    const { token, userId } = await seedUser(store);
    await store.upsertPushSubscription(userId, {
      endpoint: 'https://push.example.invalid/a',
      p256dh: 'k',
      auth: 'a',
      userAgent: 'test',
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: PASSWORD },
    });
    assert.equal(response.statusCode, 204);
    assert.equal(store.users.get(userId)?.status, 'pending_deletion');
    assert.equal((await store.listPushSubscriptions(userId)).length, 0);

    const afterwards = await app.inject({
      method: 'GET',
      url: '/v1/diaries/today',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(afterwards.statusCode, 401);
    await app.close();
  });
});

/* ------------------------- 调度器（脏数据不能拖垮全队） ------------------------- */

describe('审查修复：调度器韧性', () => {
  interface Harness {
    store: FakeStore;
    deps: SchedulerDeps;
    sent: string[];
  }

  function harness(options: { poisonFirstUser?: boolean; disableSecondUser?: boolean } = {}): Harness {
    const store = createFakeStore();
    const bad = store.addUser({ username: 'bad', passwordHash: 'x'.repeat(20), status: 'active' });
    const good = store.addUser({ username: 'good', passwordHash: 'x'.repeat(20), status: 'active' });
    if (options.disableSecondUser) {
      // 注意：要通过 store.users 改，addUser 返回的不一定是库里那个对象
      const stored = store.users.get(good.id);
      if (stored) stored.status = 'disabled';
    }

    const sent: string[] = [];
    const endpoints: Record<string, string> = {};
    for (const user of [bad, good]) {
      store.seedSchedule(user.id, 'morning' as ReminderKind, AT);
      endpoints[user.id] = `https://push.example.invalid/${user.username}`;
    }

    const combined: CombinedStore = {
      ...store,
      listPushSubscriptions: async (userId: string) => {
        const endpoint = endpoints[userId];
        if (!endpoint) return [];
        const subscription: PushSubscriptionRecord = {
          id: `sub-${userId}`,
          endpoint,
          p256dh: 'k',
          auth: 'a',
          userAgent: 'test',
          disabledAt: null,
          createdAt: AT,
          failureCount: 0,
        };
        return [subscription];
      },
      ...(options.poisonFirstUser
        ? {
            // 只让"坏账号"抛异常（模拟它存了坏时区），另一个账号必须照常工作
            getReminderSettings: async (userId: string) => {
              if (userId === bad.id) throw new RangeError('不是合法的 IANA 时区：Broken/Zone');
              return await store.getReminderSettings(userId);
            },
          }
        : {}),
    };

    return {
      store,
      sent,
      deps: {
        store: combined,
        sender: {
          async send(subscription) {
            sent.push(subscription.endpoint);
            return { status: 'sent' as const };
          },
        },
        now: () => AT,
        log: () => undefined,
      },
    };
  }

  it('坏账号抛异常时，好账号的提醒照常发出（tick 不中断）', async () => {
    const { deps, sent } = harness({ poisonFirstUser: true });
    const report = await runDueReminders(deps, AT);

    assert.equal(report.errors, 1, '坏账号记为一次错误');
    assert.equal(report.sent, 1, '好账号仍然发出');
    assert.deepEqual(sent, ['https://push.example.invalid/good']);
  });

  it('被停用的账号不再收到提醒，同一个 tick 里其他账号照发', async () => {
    const { deps, sent } = harness({ disableSecondUser: true });
    await runDueReminders(deps, AT);
    // bad 仍然 active → 照发；good 被停用 → 不发（排程被停掉）
    assert.deepEqual(sent, ['https://push.example.invalid/bad']);
  });
});

/* --------------------------- 真 SQL 上的账号删除链路 --------------------------- */

describe('审查修复：账号删除（PGlite 真 SQL）', () => {
  let db: Db;
  let store: CombinedStore;

  before(async () => {
    db = await createTestDb();
    store = { ...createPgStore(db), ...createNotificationStore(db) } as CombinedStore;
  });

  after(async () => {
    await db.close();
  });

  it('宽限期内不清除、到期后硬删除（日记被级联带走）', async () => {
    const username = `del_${Date.now().toString(36)}`;
    const user = await createUser(db, { username, password: PASSWORD });
    await store.upsertDiaryFields(
      user.id,
      '2026-09-10',
      [{ field: 'day_events', value: '删号前的日记', baseUpdatedAt: null }],
      new Date('2026-09-10T04:00:00Z'),
    );

    await store.requestAccountDeletion(user.id, new Date('2026-09-10T05:00:00Z'));
    const pending = await db.query<{ status: string; deletion_requested_at: Date | null }>(
      'SELECT status, deletion_requested_at FROM users WHERE id = $1',
      [user.id],
    );
    assert.equal(pending.rows[0]?.status, 'pending_deletion');
    assert.ok(pending.rows[0]?.deletion_requested_at, '记录了申请时间');

    const early = await purgeExpiredAccounts(db, 7, new Date('2026-09-12T00:00:00Z'));
    assert.equal(early, 0, '宽限期内不动');
    assert.equal((await db.query('SELECT id FROM users WHERE id = $1', [user.id])).rows.length, 1);

    const late = await purgeExpiredAccounts(db, 7, new Date('2026-09-18T00:00:00Z'));
    assert.equal(late, 1, '过了宽限期被清除');
    assert.equal((await db.query('SELECT id FROM users WHERE id = $1', [user.id])).rows.length, 0);
    assert.equal(
      (await db.query('SELECT id FROM daily_entries WHERE user_id = $1', [user.id])).rows.length,
      0,
      '日记随账号一起消失',
    );
  });

  it('purgeUser 立刻清除指定账号', async () => {
    const username = `now_${Date.now().toString(36)}`;
    const user = await createUser(db, { username, password: PASSWORD });
    await purgeUser(db, username);
    assert.equal((await db.query('SELECT id FROM users WHERE id = $1', [user.id])).rows.length, 0);
  });

  it('申请删除会立刻吊销全部会话，findLiveSession 随即返回 null', async () => {
    const username = `sess_${Date.now().toString(36)}`;
    const user = await createUser(db, { username, password: PASSWORD });
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await store.createSession({
      userId: user.id,
      sessionId,
      refreshTokenHash: 'b'.repeat(64),
      expiresAt: new Date('2026-10-10T00:00:00Z'),
    });
    assert.ok(await store.findLiveSession(user.id, sessionId, new Date('2026-09-10T04:00:00Z')));

    await store.requestAccountDeletion(user.id, new Date('2026-09-10T05:00:00Z'));

    assert.equal(await store.findLiveSession(user.id, sessionId, new Date('2026-09-10T06:00:00Z')), null);
    const sessions = await db.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM refresh_tokens WHERE user_id = $1',
      [user.id],
    );
    assert.ok(sessions.rows.length > 0);
    assert.ok(
      sessions.rows.every((row: { revoked_at: Date | null }) => row.revoked_at !== null),
      '全部会话都被吊销',
    );
  });
});
