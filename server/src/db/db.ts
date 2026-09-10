/**
 * 数据库访问的最小抽象。
 *
 * 只暴露三件事（query / exec / transaction），目的是：
 *  - 生产用 `pg`（server/src/db/pg.ts，连接池）；
 *  - 测试用 PGlite（WASM 版真 Postgres，见 test/helpers/pglite.ts），
 *    这样迁移、约束、SQL 全都能在本机验证，不需要装 Postgres；
 *  - 业务代码只依赖这个接口，不被某个客户端的类型牵着走。
 */

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface Db {
  /** 参数化查询（永远用这个，别拼字符串） */
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>>;
  /** 执行多语句 SQL（比如迁移文件），不接受参数 */
  exec(sql: string): Promise<void>;
  /** 事务：fn 拿到的 tx 只在这条连接/事务内有效 */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Postgres 唯一约束冲突 */
export const UNIQUE_VIOLATION = '23505';
/** Postgres CHECK 约束冲突 */
export const CHECK_VIOLATION = '23514';
/** Postgres 外键约束冲突 */
export const FOREIGN_KEY_VIOLATION = '23503';

export function errorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export function isUniqueViolation(error: unknown): boolean {
  return errorCode(error) === UNIQUE_VIOLATION;
}
