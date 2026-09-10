/**
 * 迁移入口（容器启动时自动执行，见 Dockerfile 的 CMD）：
 *   node server/src/db/migrate.ts
 *
 * 幂等：已应用的迁移会跳过；改动历史迁移会直接报错并退出（进程退出码 1，
 * 于是容器启动失败而不是带着半套结构继续跑）。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config.ts';
import { runMigrations } from './migrator.ts';
import { createPgDb } from './pg.ts';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const config = loadConfig();
const db = createPgDb({ connectionString: config.databaseUrl });

try {
  const report = await runMigrations(db, migrationsDir);
  const detail = report.applied.length > 0 ? `（应用：${report.applied.join(', ')}）` : '';
  console.log(`迁移完成：应用 ${report.applied.length} 个，跳过 ${report.skipped.length} 个${detail}`);
} catch (error) {
  console.error('迁移失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.close();
}
