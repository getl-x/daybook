/**
 * daybook · 认证核心（零依赖，只用 node:crypto）
 *
 * 三件事：
 *  1. 口令：scrypt（内存硬化 KDF）的哈希与校验，存储格式 `scrypt$N$r$p$salt$hash`；
 *  2. 访问令牌：HS256 的 JWT，签发与校验都在这里（固定算法，拒绝 alg=none）；
 *  3. 刷新令牌：高熵随机串，数据库里只存 SHA-256 哈希。
 *
 * 不引第三方库，因此可以用 `node --test` 直接跑（server/test/auth.test.ts），
 * 也可以塞进 Docker 镜像里零额外依赖运行。若日后要换 argon2id，
 * 只需替换 hashPassword / verifyPassword 的实现——哈希串自带算法前缀。
 *
 * 设计取舍（见 DAYBOOK-DESIGN.zh-CN.md §6.2、§10）：
 *  - 口令做 NFKC 归一化后再哈希：iOS/Android 键盘容易产出等价但字节不同的字符串；
 *  - 登录失败一律返回同一个错误（不区分"用户不存在"与"密码错"），并且用户不存在时
 *    也跑一次 KDF，避免时序侧信道暴露用户名是否存在。
 */
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';

/* ------------------------------- 口令 ---------------------------------- */

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

/** scrypt 参数：内存 128·N·r ≈ 32 MiB，老 CPU 上也只要约 100 ms。 */
export const SCRYPT_N = 32_768;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
/** 128·N·r 是 scrypt 的内存占用，×2 留余量；Node 默认 maxmem 只有 32 MiB，必须显式放宽。 */
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;
const SCRYPT_PREFIX = 'scrypt';
const SALT_SEPARATOR = '$';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

/** 口令归一化：全角/半角、组合字符等差异不该影响"同一个密码"。 */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

export function assertPasswordPolicy(password: string): void {
  if (typeof password !== 'string') throw new PasswordPolicyError('口令必须是字符串');
  const normalized = normalizePassword(password);
  if (normalized.length < PASSWORD_MIN_LENGTH) {
    throw new PasswordPolicyError(`口令至少 ${PASSWORD_MIN_LENGTH} 个字符`);
  }
  if (normalized.length > PASSWORD_MAX_LENGTH) {
    throw new PasswordPolicyError(`口令最多 ${PASSWORD_MAX_LENGTH} 个字符`);
  }
  if (new Set(normalized).size < 4) {
    throw new PasswordPolicyError('口令过于简单：至少需要 4 个不同的字符');
  }
}

function deriveKey(password: string, salt: Buffer, params: ScryptParams, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      normalizePassword(password),
      salt,
      keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

const DEFAULT_PARAMS: ScryptParams = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM };

/** 生成存储串：`scrypt$32768$8$1$<salt b64url>$<hash b64url>`。 */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await deriveKey(password, salt, DEFAULT_PARAMS, SCRYPT_KEYLEN);
  return [
    SCRYPT_PREFIX,
    DEFAULT_PARAMS.N,
    DEFAULT_PARAMS.r,
    DEFAULT_PARAMS.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join(SALT_SEPARATOR);
}

function parseStoredHash(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  if (typeof stored !== 'string') return null;
  const parts = stored.split(SALT_SEPARATOR);
  if (parts.length !== 6) return null;
  const [prefix, rawN, rawR, rawP, rawSalt, rawKey] = parts;
  if (prefix !== SCRYPT_PREFIX) return null;

  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N <= 1 || r <= 0 || p <= 0) return null;
  // N 必须是 2 的幂；上限防止被篡改的哈希串拖垮内存
  if ((N & (N - 1)) !== 0 || N > 1_048_576) return null;

  const salt = Buffer.from(rawSalt, 'base64url');
  const key = Buffer.from(rawKey, 'base64url');
  // 长度必须完全匹配：截断或被改短的哈希串绝不能自证成立
  if (salt.length !== SCRYPT_SALT_BYTES || key.length !== SCRYPT_KEYLEN) return null;

  return { params: { N, r, p, maxmem: Math.max(SCRYPT_MAXMEM, 128 * N * r * 2) }, salt, key };
}

/** 校验口令。任何异常输入都返回 false，绝不抛出（登录路径不该因脏数据 500）。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== 'string') return false;
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  try {
    const key = await deriveKey(password, parsed.salt, parsed.params, SCRYPT_KEYLEN);
    return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
  } catch {
    return false;
  }
}

/**
 * 用户不存在时也跑一次等价开销的 KDF，避免攻击者用响应时间判断用户名是否存在。
 * 传入任意字符串即可（内部固定用一段不会匹配的哈希串）。
 */
export const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/* ------------------------------- 访问令牌 -------------------------------- */

export interface AccessTokenClaims {
  /** 用户 id */
  sub: string;
  /** 会话 id（对应 refresh_tokens.id）：登出/停用时可整体失效 */
  sid: string;
  iat: number;
  exp: number;
  nbf?: number;
}

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 60;

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function signAccessToken(
  userId: string,
  sessionId: string,
  secret: string,
  ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
  now: Date = new Date(),
): string {
  if (!secret) throw new Error('JWT_SECRET 不能为空');
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const claims: AccessTokenClaims = { sub: userId, sid: sessionId, iat: issuedAt, exp: issuedAt + ttlSeconds };
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

/** 校验令牌；任何不合法（过期、篡改、算法不对、格式错）一律返回 null。 */
export function verifyAccessToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): AccessTokenClaims | null {
  if (typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, claimsPart, signaturePart] = parts;

  const header = decodeJson(headerPart);
  // 固定算法：不接受 alg=none，也不接受 RS256/HS512 之类的降级尝试
  if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') return null;

  const expected = createHmac('sha256', secret).update(`${headerPart}.${claimsPart}`).digest();
  const actual = Buffer.from(signaturePart, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  const claims = decodeJson(claimsPart);
  if (!claims) return null;
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null;
  if (typeof claims.sid !== 'string' || claims.sid.length === 0) return null;
  if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') return null;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (claims.exp <= nowSeconds) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS) return null;

  return { sub: claims.sub, sid: claims.sid, iat: claims.iat, exp: claims.exp, nbf: claims.nbf as number | undefined };
}

/* ------------------------------- 刷新令牌 -------------------------------- */

const REFRESH_TOKEN_BYTES = 32;
export const REFRESH_TOKEN_TTL_DAYS = 30;

/** 生成刷新令牌；返回明文（只交给客户端一次）与入库用的哈希。 */
export function createRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/** 刷新令牌是高熵随机串，不需要慢哈希，SHA-256 足够。 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function refreshTokenExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** 会话 id：refresh_tokens.id 与 access 令牌的 sid 用同一个值。 */
export function newSessionId(): string {
  return randomUUID();
}

/* -------------------------------- 用户名 --------------------------------- */

export const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/;

/** 统一小写去空格——数据库里有 `username = lower(username)` 的 CHECK 约束。 */
export function normalizeUsername(raw: string): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

export function isValidUsername(raw: string): boolean {
  return USERNAME_PATTERN.test(normalizeUsername(raw));
}
