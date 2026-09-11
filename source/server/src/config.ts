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
  /**
   * 允许跨源访问本 API 的源（CORS）。
   *
   * 浏览器里的 PWA 与后端同源，用不上它；**Android APK** 的 WebView 源是
   * `https://localhost`，必须在这里放行（见 DEFAULT_CORS_ORIGINS）。
   * 可用 `CORS_ORIGINS` 覆盖（逗号分隔）来额外放行别的源。
   *
   * 可选是为了让测试里的 Config 字面量不必每个都补这个字段；
   * `loadConfig` 一定会给出值，`app.ts` 对缺省值回退到 DEFAULT_CORS_ORIGINS。
   */
  corsOrigins?: readonly string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_PORT = 8090;
const MIN_JWT_SECRET_LENGTH = 32;

/**
 * 默认放行的跨源源：Capacitor 壳（Android APK / 未来的 iOS）里的 WebView
 * 用 `https://localhost`（`androidScheme: https`）；iOS 侧是 `capacitor://localhost`。
 * 浏览器里的 PWA 与后端同源，压根不会用到 CORS。
 */
export const DEFAULT_CORS_ORIGINS: readonly string[] = ['https://localhost', 'capacitor://localhost'];

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

/**
 * CORS_ORIGINS：逗号分隔的源名单；不配就用默认（Capacitor 壳那两条）。
 * 写错的项直接报错——CORS 名单静默写宽了比报错危险得多。
 */
function parseCorsOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CORS_ORIGINS;

  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  if (origins.length === 0) return DEFAULT_CORS_ORIGINS;

  for (const origin of origins) {
    if (!/^(https?:\/\/|capacitor:\/\/)[^\s]+$/.test(origin)) {
      throw new ConfigError(
        `CORS_ORIGINS 里有一项不是合法的源：${origin}（示例：https://localhost,https://diary.example.com）`,
      );
    }
  }
  return origins;
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

  return { nodeEnv, port, databaseUrl, jwtSecret, logLevel, vapid: parseVapid(env), corsOrigins: parseCorsOrigins(env.CORS_ORIGINS) };
}
