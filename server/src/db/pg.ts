/**
 * 生产环境的 Postgres 适配：把 `pg` 的连接池包装成 Db 接口。
 *
 * 事务用池里单条连接实现（BEGIN/COMMIT/ROLLBACK 都在同一条连接上），
 * 事务内拿到的 tx 不再支持嵌套事务——需要嵌套说明设计有问题。
 */
import { Pool } from 'pg';

import type { Db, QueryResult } from './db.ts';

export interface PgDbOptions {
  connectionString: string;
  /** 连接池上限：小机器上 10 足够（见计划 §7.3） */
  max?: number;
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export function createPgDb({ connectionString, max = 10 }: PgDbOptions): Db {
  const pool = new Pool({ connectionString, max, application_name: 'daybook' });

  const scoped = (queryable: Queryable, inTransaction: boolean): Db => ({
    async query<Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>> {
      const result = await queryable.query(sql, params ? [...params] : undefined);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },

    async exec(sql: string): Promise<void> {
      await queryable.query(sql);
    },

    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (inTransaction) throw new Error('不支持嵌套事务');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(scoped(client as unknown as Queryable, true));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      if (!inTransaction) await pool.end();
    },
  });

  return scoped(pool as unknown as Queryable, false);
}
