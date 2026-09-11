/**
 * 服务入口：config → Postgres store → Fastify，监听 8090（容器内）；
 * 同时跑提醒调度（每分钟一次 tick）。
 *
 * 反代由使用者自行部署（nginx 等）指向 http://127.0.0.1:8090，见计划 §7.1。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createNotificationStore } from './db/notification-store.ts';
import { createPgDb } from './db/pg.ts';
import { createPgStore } from './db/store.ts';
import { createPushSender } from './push.ts';
import { runDueReminders } from './scheduler.ts';
import { registerWebApp } from './static.ts';
import { purgeExpiredAccounts } from './users.ts';
import { resolveVapidKeys } from './vapid.ts';

const config = loadConfig();
const db = createPgDb({ connectionString: config.databaseUrl });
/** 账号删除的宽限期（天）：申请后 7 天内可反悔，到期由每分钟的 tick 真正清除 */
const ACCOUNT_DELETION_GRACE_DAYS = 7;
// 两个 store 合成一个：日记/认证 + 提醒/推送
const store = { ...createPgStore(db), ...createNotificationStore(db) };

// VAPID 密钥解析（必须在 buildApp 之前）：环境变量 > 数据库已存 > 自动生成并入库。
// 这样 Web Push 无需手配 .env 也能开箱可用（见 src/vapid.ts）。
const resolvedVapid = await resolveVapidKeys({
  envVapid: config.vapid,
  subject: process.env.VAPID_SUBJECT,
  store,
  log: (level, message, extra) => {
    const line = `[vapid] ${message}`;
    if (level === 'error') console.error(line, extra ?? '');
    else if (level === 'warn') console.warn(line, extra ?? '');
    else console.log(line, extra ?? '');
  },
});
const appConfig = { ...config, vapid: resolvedVapid };

const app = buildApp({ config: appConfig, store, now: () => new Date() });

// 密钥一定可用（缺就会自动生成）→ 推送发送器恒非 null
const pushSender = createPushSender({
  publicKey: resolvedVapid.publicKey,
  privateKey: resolvedVapid.privateKey,
  subject: resolvedVapid.subject,
});

const TICK_MS = 60_000;

async function tick(): Promise<void> {
  try {
    const report = await runDueReminders({
      store,
      sender: pushSender,
      now: () => new Date(),
      log: (level, message, extra) => app.log[level](extra ?? {}, message),
      // 搭每分钟的 tick 顺手清理过了 7 天宽限期的待删除账号（验收标准第 10 条）
      purgeExpiredAccounts: () => purgeExpiredAccounts(db, ACCOUNT_DELETION_GRACE_DAYS),
    });
    if (report.due > 0) app.log.info({ report }, '提醒 tick 完成');
  } catch (error) {
    app.log.error(error, '提醒 tick 失败（下一分钟会重试）');
  }
}

// 前端产物（镜像里是 /app/web/dist）；本地开发用 vite dev 时这里会优雅降级
const webDistDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
const servedWeb = await registerWebApp(app, webDistDir);
app.log.info(servedWeb ? `前端产物已挂载：${webDistDir}` : `未找到前端产物（${webDistDir}），本次只提供 API`);

let shuttingDown = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`收到 ${signal}，正在关闭…`);
  if (tickTimer) clearInterval(tickTimer);
  try {
    await app.close();
    await db.close();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

try {
  // 容器里监听 0.0.0.0，端口映射把公网访问挡在 127.0.0.1 之外（见 compose.yml）
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`daybook 已就绪：容器内 :${config.port}，反代请指向 http://127.0.0.1:${config.port}`);

  tickTimer = setInterval(() => void tick(), TICK_MS);
  // 启动时立刻跑一次：补上服务重启期间错过的提醒
  void tick();
} catch (error) {
  app.log.error(error);
  await db.close();
  process.exit(1);
}
