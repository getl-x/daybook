/**
 * 账号管理 CLI（管理员侧，注册已关闭，账号只能从这里开）：
 *
 *   node server/src/cli/user.ts create --username getl [--timezone Asia/Shanghai]
 *   node server/src/cli/user.ts reset-password --username getl
 *   node server/src/cli/user.ts disable --username getl
 *   node server/src/cli/user.ts enable --username getl
 *   node server/src/cli/user.ts list
 *
 * 口令从标准输入读取，不经过命令行参数（不落 shell 历史）：
 *  - 交互式终端：不回显，要求输入两次；
 *  - 管道：`echo '口令' | node …`（容器里常用 `docker compose exec -T`）。
 */
import { loadConfig } from '../config.ts';
import { createPgDb } from '../db/pg.ts';
import { createUser, listUsers, purgeExpiredAccounts, purgeUser, resetPassword, setUserStatus } from '../users.ts';

function printUsage(): void {
  console.log(`daybook 账号管理

用法：
  node server/src/cli/user.ts create --username <名字> [--timezone Asia/Shanghai]
  node server/src/cli/user.ts reset-password --username <名字>
  node server/src/cli/user.ts disable --username <名字>
  node server/src/cli/user.ts enable --username <名字>
  node server/src/cli/user.ts list

说明：
  · 口令从标准输入读取（不回显），不写进命令行参数；
  · 用户名 3–32 位，只允许小写字母、数字、下划线、连字符。`);
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=');
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[rawKey] = next;
      index += 1;
    } else {
      flags[rawKey] = '';
    }
  }
  return flags;
}

async function readPipedSecret(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  const first = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
  if (!first) throw new Error('标准输入里没有读到口令');
  return first;
}

async function readInteractiveSecret(label: string): Promise<string> {
  process.stdout.write(label);
  return await new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const finish = (result: () => void): void => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write('\n');
      result();
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish(() => resolve(value));
        if (char === '\u0003') return finish(() => reject(new Error('已取消')));
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function readNewPassword(): Promise<string> {
  if (!process.stdin.isTTY) return await readPipedSecret();
  const first = await readInteractiveSecret('请输入口令（不回显）：');
  const second = await readInteractiveSecret('请再输入一次：');
  if (first !== second) throw new Error('两次输入不一致');
  return first;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (!command || command === 'help' || command === '--help') {
    printUsage();
    return;
  }

  const config = loadConfig();
  const db = createPgDb({ connectionString: config.databaseUrl });

  try {
    switch (command) {
      case 'create': {
        if (!flags.username) throw new Error('缺少 --username');
        const user = await createUser(db, {
          username: flags.username,
          password: await readNewPassword(),
          ...(flags.timezone ? { timezone: flags.timezone } : {}),
        });
        console.log(`已创建账号 ${user.username}（id=${user.id}，状态 ${user.status}）`);
        break;
      }
      case 'reset-password': {
        if (!flags.username) throw new Error('缺少 --username');
        const user = await resetPassword(db, { username: flags.username, password: await readNewPassword() });
        console.log(`已重置 ${user.username} 的口令；该账号已有的登录令牌不受影响，必要时请一并停用再启用。`);
        break;
      }
      case 'disable':
      case 'enable': {
        if (!flags.username) throw new Error('缺少 --username');
        const status = command === 'disable' ? 'disabled' : 'active';
        const user = await setUserStatus(db, { username: flags.username, status });
        console.log(`账号 ${user.username} 现在是 ${user.status}${status === 'disabled' ? '（既有令牌会在下一次校验时失效）' : ''}`);
        break;
      }
      case 'list': {
        const users = await listUsers(db);
        if (users.length === 0) {
          console.log('还没有任何账号。用 create 建一个吧。');
          break;
        }
        for (const user of users) {
          const lastLogin = user.lastLoginAt ? user.lastLoginAt.replace('T', ' ').slice(0, 19) : '从未登录';
          console.log(`${user.username.padEnd(20)} ${user.status.padEnd(10)} 创建 ${user.createdAt.slice(0, 10)}  最后登录 ${lastLogin}`);
        }
        break;
      }
      case 'purge-expired': {
        // 正常由每分钟的 tick 自动跑；这里给管理员手动触发用（例如停机期间积累的）
        const purged = await purgeExpiredAccounts(db, Number(flags.grace_days ?? 7));
        console.log(`已清除 ${purged} 个宽限期到期的账号`);
        break;
      }
      case 'purge': {
        // 强制立即清除（不进宽限期）：用户忘了口令/要求马上删时用
        if (!flags.username) throw new Error('缺少 --username');
        await purgeUser(db, flags.username);
        console.log(`已立即清除账号 ${flags.username} 及其全部数据`);
        break;
      }
      default: {
        console.error(`未知命令：${command}`);
        printUsage();
        process.exitCode = 1;
      }
    }
  } finally {
    await db.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
