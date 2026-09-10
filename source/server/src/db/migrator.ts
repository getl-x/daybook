/**
 * 迁移跑器：把 migrations/*.sql 按文件名顺序应用一次，并记录校验和。
 *
 * 规则：
 *  - 已应用过的迁移**文件内容不能变**——改了会直接报错（新增迁移文件才是正道）；
 *  - 每个迁移在自己的事务里执行，失败就整体回滚，不会留下半套结构；
 *  - 幂等：重复调用只会跳过已应用的文件。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Db } from './db.ts';

export interface MigrationReport {
  applied: string[];
  skipped: string[];
}

const TABLE = 'schema_migrations';

export class MigrationChecksumError extends Error {
  // 注意：类型擦除不支持构造器参数属性，字段要显式声明
  readonly migration: string;
  readonly expected: string;
  readonly actual: string;

  constructor(migration: string, expected: string, actual: string) {
    super(
      `迁移 ${migration} 在应用之后被改动过（校验和 ${expected.slice(0, 12)}… → ${actual.slice(0, 12)}…）。请新增一个迁移文件，不要改历史迁移。`,
    );
    this.name = 'MigrationChecksumError';
    this.migration = migration;
    this.expected = expected;
    this.actual = actual;
  }
}

export async function runMigrations(db: Db, migrationsDir: string): Promise<MigrationReport> {
  await db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    name       text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  );`);

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  const recorded = await db.query<{ name: string; checksum: string }>(`SELECT name, checksum FROM ${TABLE}`);
  const appliedMap = new Map(recorded.rows.map((row) => [row.name, row.checksum]));

  const report: MigrationReport = { applied: [], skipped: [] };

  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = appliedMap.get(file);

    if (previous !== undefined) {
      if (previous !== checksum) throw new MigrationChecksumError(file, previous, checksum);
      report.skipped.push(file);
      continue;
    }

    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(`INSERT INTO ${TABLE} (name, checksum) VALUES ($1, $2)`, [file, checksum]);
    });
    report.applied.push(file);
  }

  return report;
}
