/**
 * 日记存储层与会话存储的**真实 SQL** 测试（PGlite = 进程内真 Postgres）。
 *
 * 这里验的是 SQL 语义：字段级 upsert、version 递增、reviewed_at/summarized_at 首次写入、
 * 逐字段冲突判定、用户隔离、会话轮转。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPgStore } from '../src/db/store.ts';
import { createUser } from '../src/users.ts';
import { createTestDb } from './helpers/pglite.ts';

const PASSWORD = 'correct horse battery';
const TODAY = '2026-09-10';

async function setup() {
  const db = await createTestDb();
  const store = createPgStore(db);
  const alice = await createUser(db, { username: 'alice', password: PASSWORD });
  const bob = await createUser(db, { username: 'bob', password: PASSWORD });
  return { db, store, alice, bob };
}

describe('字段级写入（真实 SQL）', () => {
  it('没有记录时读出 null，写入后 version 从 1 开始，entry_date 是纯日期字符串', async () => {
    const { db, store, alice } = await setup();

    assert.equal(await store.getDiaryEntry(alice.id, TODAY), null);

    const at = new Date('2026-09-10T01:00:00Z');
    const result = await store.upsertDiaryFields(alice.id, TODAY, [
      { field: 'day_plan', value: '写日记核心', baseUpdatedAt: null },
    ], at);

    assert.equal(result.entryDate, TODAY);
    assert.equal(result.version, 1);
    assert.deepEqual(result.fields.day_plan, {
      value: '写日记核心',
      updatedAt: at.toISOString(),
      overwritten: false,
    });

    const entry = await store.getDiaryEntry(alice.id, TODAY);
    assert.ok(entry);
    assert.equal(entry.exists, true);
    assert.equal(entry.entryDate, TODAY, 'entry_date 必须原样返回 YYYY-MM-DD，不能被驱动转成 Date');
    assert.equal(entry.fields.day_plan.value, '写日记核心');
    assert.equal(entry.fields.day_events.value, null);
    await db.close();
  });

  it('只写变更字段：另一个字段的值与 updatedAt 保持不变，version 递增', async () => {
    const { db, store, alice } = await setup();
    const first = new Date('2026-09-10T01:00:00Z');
    const second = new Date('2026-09-10T02:00:00Z');

    await store.upsertDiaryFields(alice.id, TODAY, [{ field: 'day_plan', value: '计划 A', baseUpdatedAt: null }], first);
    const result = await store.upsertDiaryFields(
      alice.id,
      TODAY,
      [{ field: 'evening_summary', value: '总结 B', baseUpdatedAt: null }],
      second,
    );
    assert.equal(result.version, 2);
    assert.deepEqual(result.fields.evening_summary, {
      value: '总结 B',
      updatedAt: second.toISOString(),
      overwritten: false,
    });

    const entry = await store.getDiaryEntry(alice.id, TODAY);
    assert.ok(entry);
    assert.equal(entry.fields.day_plan.value, '计划 A');
    assert.equal(entry.fields.day_plan.updatedAt, first.toISOString(), '未提交的字段不该被刷新');
    assert.equal(entry.fields.evening_summary.updatedAt, second.toISOString());
    await db.close();
  });

  it('reviewed_at / summarized_at 只在首次非空写入时落一次', async () => {
    const { db, store, alice } = await setup();

    // 空串不算"写过"
    await store.upsertDiaryFields(alice.id, TODAY, [{ field: 'day_events', value: '', baseUpdatedAt: null }], new Date());
    let row = await db.query<{ reviewed_at: Date | null; summarized_at: Date | null }>(
      'SELECT reviewed_at, summarized_at FROM daily_entries WHERE user_id = $1 AND entry_date = $2',
      [alice.id, TODAY],
    );
    assert.equal(row.rows[0]?.reviewed_at ?? null, null, '写空串不该记 reviewed_at');

    await store.upsertDiaryFields(alice.id, TODAY, [{ field: 'day_events', value: '开会', baseUpdatedAt: null }], new Date());
    row = await db.query('SELECT reviewed_at, summarized_at FROM daily_entries WHERE user_id = $1 AND entry_date = $2', [
      alice.id,
      TODAY,
    ]);
    const firstReviewedAt = row.rows[0]?.reviewed_at ?? null;
    assert.ok(firstReviewedAt instanceof Date);

    await store.upsertDiaryFields(alice.id, TODAY, [{ field: 'day_meals', value: '面', baseUpdatedAt: null }], new Date());
    row = await db.query('SELECT reviewed_at FROM daily_entries WHERE user_id = $1 AND entry_date = $2', [
      alice.id,
      TODAY,
    ]);
    assert.equal(
      (row.rows[0]?.reviewed_at as Date).getTime(),
      (firstReviewedAt as Date).getTime(),
      'reviewed_at 不该被后续写入刷新',
    );

    await store.upsertDiaryFields(alice.id, TODAY, [{ field: 'evening_summary', value: '还行', baseUpdatedAt: null }], new Date());
    row = await db.query('SELECT summarized_at FROM daily_entries WHERE user_id = $1 AND entry_date = $2', [
      alice.id,
      TODAY,
    ]);
    assert.ok(row.rows[0]?.summarized_at instanceof Date);
    await db.close();
  });

  it('逐字段冲突判定：基准比服务端旧 → overwritten=true，但仍写入', async () => {
    const { db, store, alice } = await setup();
    const first = new Date('2026-09-10T01:00:00Z');

    await store.upsertDiaryFields(alice.id, TODAY, [{ field: 'day_plan', value: '手机端写的', baseUpdatedAt: null }], first);

    // 基准更早 → 冲突
    const conflict = await store.upsertDiaryFields(
      alice.id,
      TODAY,
      [{ field: 'day_plan', value: '电脑端覆盖', baseUpdatedAt: '2026-09-01T00:00:00.000Z' }],
      new Date('2026-09-10T03:00:00Z'),
    );
    assert.equal(conflict.fields.day_plan?.overwritten, true);

    // 基准正好是服务端当前值 → 不冲突
    const clean = await store.upsertDiaryFields(
      alice.id,
      TODAY,
      [{ field: 'day_plan', value: '再改一次', baseUpdatedAt: '2026-09-10T03:00:00.000Z' }],
      new Date('2026-09-10T04:00:00Z'),
    );
    assert.equal(clean.fields.day_plan?.overwritten, false);

    const entry = await store.getDiaryEntry(alice.id, TODAY);
    assert.equal(entry?.fields.day_plan.value, '再改一次');
    await db.close();
  });

  it('同一天同一用户只有一行（多次写入不产生重复）', async () => {
    const { db, store, alice } = await setup();
    for (const value of ['a', 'b', 'c']) {
      await store.upsertDiaryFields(alice.id, TODAY, [{ field: 'day_plan', value, baseUpdatedAt: null }], new Date());
    }
    const { rows } = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM daily_entries WHERE user_id = $1 AND entry_date = $2',
      [alice.id, TODAY],
    );
    assert.equal(rows[0]?.count, 1);
    await db.close();
  });

  it('用户之间互相看不到（所有查询都带 user_id）', async () => {
    const { db, store, alice, bob } = await setup();
    await store.upsertDiaryFields(alice.id, TODAY, [{ field: 'day_events', value: 'alice 的私密内容', baseUpdatedAt: null }], new Date());

    assert.equal(await store.getDiaryEntry(bob.id, TODAY), null);
    const bobEntry = await store.upsertDiaryFields(bob.id, TODAY, [{ field: 'day_events', value: 'bob 的内容', baseUpdatedAt: null }], new Date());
    assert.equal(bobEntry.version, 1, 'bob 是独立的一行');

    const aliceEntry = await store.getDiaryEntry(alice.id, TODAY);
    assert.equal(aliceEntry?.fields.day_events.value, 'alice 的私密内容');
    await db.close();
  });
});

describe('会话存储（真实 SQL）', () => {
  it('建会话、按哈希查、吊销；轮转链记录 rotated_from', async () => {
    const { db, store, alice } = await setup();
    const expiresAt = new Date('2026-10-10T00:00:00Z');

    await store.createSession({
      userId: alice.id,
      sessionId: '11111111-1111-4111-8111-111111111111',
      refreshTokenHash: 'hash-one',
      expiresAt,
    });
    const found = await store.findSessionByTokenHash('hash-one');
    assert.ok(found);
    assert.equal(found.userId, alice.id);
    assert.equal(found.expiresAt.toISOString(), expiresAt.toISOString());
    assert.equal(found.revokedAt, null);

    await store.createSession({
      userId: alice.id,
      sessionId: '22222222-2222-4222-8222-222222222222',
      refreshTokenHash: 'hash-two',
      expiresAt,
      rotatedFrom: '11111111-1111-4111-8111-111111111111',
    });
    const { rows } = await db.query<{ rotated_from: string }>(
      'SELECT rotated_from FROM refresh_tokens WHERE token_hash = $1',
      ['hash-two'],
    );
    assert.equal(rows[0]?.rotated_from, '11111111-1111-4111-8111-111111111111');

    await store.revokeSession('11111111-1111-4111-8111-111111111111', new Date('2026-09-10T05:00:00Z'));
    const revoked = await store.findSessionByTokenHash('hash-one');
    assert.ok(revoked?.revokedAt instanceof Date);
    assert.equal(await store.findSessionByTokenHash('nope'), null);
    await db.close();
  });

  it('设置：建号时自动有默认行；未知用户返回默认值', async () => {
    const { db, store, alice } = await setup();
    assert.deepEqual(await store.getUserSettings(alice.id), { timezone: 'Asia/Shanghai', dayStartHour: 4 });
    assert.deepEqual(await store.getUserSettings('00000000-0000-4000-8000-000000000000'), {
      timezone: 'Asia/Shanghai',
      dayStartHour: 4,
    });
    await db.close();
  });
});

describe('突发事情列表', () => {
  it('只取本人、当天，并按发生时间排序', async () => {
    const { db, store, alice, bob } = await setup();
    const insert = async (userId: string, date: string, occurredAt: string, content: string): Promise<void> => {
      await db.query(
        'INSERT INTO incidents (id, user_id, entry_date, occurred_at, content) VALUES (gen_random_uuid(), $1, $2, $3, $4)',
        [userId, date, occurredAt, content],
      );
    };

    await insert(alice.id, TODAY, '2026-09-10T06:00:00Z', '下午的一条');
    await insert(alice.id, TODAY, '2026-09-10T01:00:00Z', '早上的一条');
    await insert(alice.id, '2026-09-09', '2026-09-09T01:00:00Z', '昨天的一条');
    await insert(bob.id, TODAY, '2026-09-10T02:00:00Z', '别人的一条');

    const incidents = await store.listIncidents(alice.id, TODAY);
    assert.deepEqual(
      incidents.map((incident) => incident.content),
      ['早上的一条', '下午的一条'],
    );
    assert.equal(incidents[0]?.entryDate, TODAY);
    assert.ok(incidents[0]?.occurredAt.endsWith('Z'));
    await db.close();
  });
});
