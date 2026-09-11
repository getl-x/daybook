/**
 * 迁移与数据库约束的真实测试（PGlite = 进程内真 Postgres）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CHECK_VIOLATION, errorCode } from '../src/db/db.ts';
import { MigrationChecksumError, runMigrations } from '../src/db/migrator.ts';
import { MIGRATIONS_DIR, createTestDb } from './helpers/pglite.ts';

describe('迁移跑器', () => {
  it('首次应用全部迁移，重复执行只跳过；表都建出来了', async () => {
    const db = await createTestDb({ migrate: false });

    const first = await runMigrations(db, MIGRATIONS_DIR);
    assert.deepEqual(first.applied, ['0000_init.sql', '0001_account_deletion.sql', '0002_app_settings_and_quiet_hours.sql']);
    assert.deepEqual(first.skipped, []);

    const second = await runMigrations(db, MIGRATIONS_DIR);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, ['0000_init.sql', '0001_account_deletion.sql', '0002_app_settings_and_quiet_hours.sql']);

    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = rows.map((row) => row.table_name);
    for (const expected of [
      'app_settings',
      'daily_entries',
      'incidents',
      'notification_deliveries',
      'push_subscriptions',
      'refresh_tokens',
      'reminder_schedule',
      'schema_migrations',
      'user_settings',
      'users',
    ]) {
      assert.ok(tables.includes(expected), `缺少表 ${expected}`);
    }
    await db.close();
  });

  it('改动已应用的迁移文件会报错（校验和不一致）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daybook-mig-'));
    const original = await readFile(join(MIGRATIONS_DIR, '0000_init.sql'), 'utf8');
    await writeFile(join(dir, '0000_init.sql'), original, 'utf8');

    const db = await createTestDb({ migrate: false });
    await runMigrations(db, dir);

    await writeFile(join(dir, '0000_init.sql'), `${original}\n-- 事后悄悄改一行\n`, 'utf8');
    await assert.rejects(() => runMigrations(db, dir), MigrationChecksumError);
    await db.close();
  });

  it('失败的迁移整体回滚，不留半套结构', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daybook-bad-'));
    // 第二条语句必然失败（表已存在）→ 文件内的第一条语句也应一起回滚
    await writeFile(
      join(dir, '0001_broken.sql'),
      'CREATE TABLE half_applied (id int);\nCREATE TABLE half_applied (id int);\n',
      'utf8',
    );

    const db = await createTestDb({ migrate: false });
    await assert.rejects(() => runMigrations(db, dir));

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'half_applied'`,
    );
    assert.equal(tables.rows.length, 0, '前半截建的表也应随事务回滚');
    const applied = await db.query('SELECT name FROM schema_migrations');
    assert.equal(applied.rows.length, 0);
    await db.close();
  });
});

describe('数据库层的约束', () => {
  it('用户名必须是小写且符合字符集（CHECK 约束兜底）', async () => {
    const db = await createTestDb();

    await assert.rejects(
      () =>
        db.query('INSERT INTO users (id, username, password_hash) VALUES (gen_random_uuid(), $1, $2)', [
          'Admin',
          'scrypt$1$1$1$AA$AA',
        ]),
      (error: unknown) => errorCode(error) === CHECK_VIOLATION,
    );
    await assert.rejects(
      () =>
        db.query('INSERT INTO users (id, username, password_hash) VALUES (gen_random_uuid(), $1, $2)', [
          'ab',
          'scrypt$1$1$1$AA$AA',
        ]),
      (error: unknown) => errorCode(error) === CHECK_VIOLATION,
    );

    const ok = await db.query(
      'INSERT INTO users (id, username, password_hash) VALUES (gen_random_uuid(), $1, $2) RETURNING username',
      ['my_user-1', 'scrypt$1$1$1$AA$AA'],
    );
    assert.equal(ok.rows.length, 1);
    await db.close();
  });

  it('同一用户同一天只能有一条日记记录', async () => {
    const db = await createTestDb();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (id, username, password_hash) VALUES (gen_random_uuid(), 'getl', 'scrypt$1$1$1$AA$AA') RETURNING id`,
    );
    const userId = rows[0].id;

    await db.query('INSERT INTO daily_entries (id, user_id, entry_date) VALUES (gen_random_uuid(), $1, $2)', [
      userId,
      '2026-09-09',
    ]);
    await assert.rejects(
      () =>
        db.query('INSERT INTO daily_entries (id, user_id, entry_date) VALUES (gen_random_uuid(), $1, $2)', [
          userId,
          '2026-09-09',
        ]),
      (error: unknown) => errorCode(error) === '23505',
    );
    // 换一天没问题
    await db.query('INSERT INTO daily_entries (id, user_id, entry_date) VALUES (gen_random_uuid(), $1, $2)', [
      userId,
      '2026-09-10',
    ]);
    await db.close();
  });
});
