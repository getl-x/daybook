/**
 * 测试用的真实数据库：PGlite（Postgres 编译成 WASM，跑在进程内）。
 *
 * 好处：迁移、约束、SQL 全都在本机真跑，不需要 docker 或外部 Postgres；
 * 生产用 server/src/db/pg.ts（pg 连接池），两者都实现同一个 Db 接口。
 */
import { PGlite } from '@electric-sql/pglite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Db, QueryResult } from '../../src/db/db.ts';
import { runMigrations } from '../../src/db/migrator.ts';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

function scoped(client: PGlite): Db {
  return {
    async query<Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>> {
      const result = await client.query<Row>(sql, params ? [...params] : undefined);
      const affected = (result as { affectedRows?: number }).affectedRows;
      return {
        rows: result.rows,
        rowCount: typeof affected === 'number' ? affected : result.rows.length,
      };
    },

    async exec(sql: string): Promise<void> {
      await client.exec(sql);
    },

    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return await client.transaction(async (tx) => await fn(scoped(tx as unknown as PGlite)));
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}

export interface TestDb extends Db {
  /** 已应用的迁移文件是否包含 0000_init.sql */
  migrated: boolean;
}

/** 建一个空库；默认顺手把迁移跑上（migrated: false 可拿到未迁移的裸库） */
export async function createTestDb(options: { migrate?: boolean } = {}): Promise<TestDb> {
  const client = new PGlite();
  await client.waitReady;
  const db = scoped(client) as TestDb;
  db.migrated = false;
  if (options.migrate !== false) {
    await runMigrations(db, MIGRATIONS_DIR);
    db.migrated = true;
  }
  return db;
}
