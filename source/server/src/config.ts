/**
 * 环境变量解析。
 *
 * 原则（见 DAYBOOK-DESIGN.zh-CN.md §13.13）：关键项缺失时**明确报错**，
 * 绝不静默用默认值把服务启动起来——部署时最怕的就是"起来了但连的是错的库"。
 */
export type NodeEnv = 'development' | 'test' | 'production';

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface Config {
  nodeEnv: NodeEnv;
  /** 容器内监听端口：固定 8090（反代由用户自备，见计划 §7.1） */
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  /** 'silent' 表示不输出日志（测试用） */
  logLevel: string;
  /** 没配就为 null——通知功能启用前必须补上 */
  vapid: VapidConfig | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_PORT = 8090;
const MIN_JWT_SECRET_LENGTH = 32;

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`缺少必需的环境变量 ${name}（.env 是否挂载进容器了？）`);
  }
  return value.trim();
}

function parseNodeEnv(raw: string | undefined): NodeEnv {
  if (raw === undefined || raw === '') return 'development';
  if (raw === 'development' || raw === 'test' || raw === 'production') return raw;
  throw new ConfigError(`NODE_ENV 只能是 development / test / production，收到：${raw}`);
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT 必须是 1–65535 的整数，收到：${raw}`);
  }
  return port;
}

function parseDatabaseUrl(raw: string): string {
  if (!/^postgres(ql)?:\/\//.test(raw)) {
    throw new ConfigError('DATABASE_URL 必须是 postgres:// 或 postgresql:// 开头的连接串');
  }
  return raw;
}

function parseVapid(env: Env): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey && !privateKey) return null;
  if (!publicKey || !privateKey) {
    throw new ConfigError('VAPID_PUBLIC_KEY 与 VAPID_PRIVATE_KEY 必须同时提供（用 npx web-push generate-vapid-keys 生成）');
  }
  return {
    publicKey,
    privateKey,
    subject: env.VAPID_SUBJECT?.trim() || 'mailto:noreply@localhost',
  };
}

export function loadConfig(env: Env = process.env): Config {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const port = parsePort(env.PORT);
  const databaseUrl = parseDatabaseUrl(required(env, 'DATABASE_URL'));
  const jwtSecret = required(env, 'JWT_SECRET');

  if (nodeEnv === 'production' && jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new ConfigError(
      `JWT_SECRET 太短：生产环境至少 ${MIN_JWT_SECRET_LENGTH} 个字符（生成：openssl rand -base64 48）`,
    );
  }

  const logLevel = env.LOG_LEVEL?.trim() || (nodeEnv === 'test' ? 'silent' : 'info');

  return { nodeEnv, port, databaseUrl, jwtSecret, logLevel, vapid: parseVapid(env) };
}
