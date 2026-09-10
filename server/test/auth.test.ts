/**
 * 认证核心的验收测试（零依赖）：node --test "server/test/*.test.ts"
 * 覆盖：口令哈希/校验、令牌过期与篡改、alg=none 降级、刷新令牌、用户名规则。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  DUMMY_HASH,
  PASSWORD_MAX_LENGTH,
  PasswordPolicyError,
  REFRESH_TOKEN_TTL_DAYS,
  assertPasswordPolicy,
  createRefreshToken,
  hashPassword,
  hashRefreshToken,
  isValidUsername,
  newSessionId,
  normalizeUsername,
  refreshTokenExpiresAt,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from '../src/auth.ts';

const SECRET = 'test-secret-please-rotate';
const GOOD_PASSWORD = 'correct horse battery';

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('口令：scrypt 哈希与校验', () => {
  it('同一条口令能校验通过，错误口令不能', async () => {
    const stored = await hashPassword(GOOD_PASSWORD);
    assert.equal(await verifyPassword(GOOD_PASSWORD, stored), true);
    assert.equal(await verifyPassword('correct horse batteru', stored), false);
    assert.equal(await verifyPassword('', stored), false);
    assert.equal(await verifyPassword(GOOD_PASSWORD + ' ', stored), false);
  });

  it('存储格式自带算法与参数，且每次盐不同', async () => {
    const first = await hashPassword(GOOD_PASSWORD);
    const second = await hashPassword(GOOD_PASSWORD);
    assert.match(first, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    const [prefix, N, r, p] = first.split('$');
    assert.equal(prefix, 'scrypt');
    assert.equal(N, '32768');
    assert.equal(r, '8');
    assert.equal(p, '1');
    assert.notEqual(first, second, '随机盐应让两次哈希不同');
    assert.equal(await verifyPassword(GOOD_PASSWORD, second), true);
  });

  it('NFKC 归一化：等价写法视为同一条口令', async () => {
    const composed = 'café-password-1';          // é 单码点
    const decomposed = 'cafe\u0301-password-1';   // e + 组合重音符
    const stored = await hashPassword(composed);
    assert.equal(await verifyPassword(decomposed, stored), true);
  });

  it('哈希串异常一律返回 false，不抛异常', async () => {
    const badInputs = [
      '',
      'not-a-hash',
      'scrypt$32768$8',
      'scrypt$32768$8$1$onlyfive',
      'scrypt$abc$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA',
      'argon2id$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA',
      'scrypt$30000$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA',   // N 不是 2 的幂
      'scrypt$2097152$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA', // N 过大
      'scrypt$32768$8$1$$',
      'scrypt$32768$0$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA',
    ];
    for (const bad of badInputs) {
      assert.equal(await verifyPassword(GOOD_PASSWORD, bad), false, `应拒绝：${bad}`);
    }
    assert.equal(await verifyPassword(GOOD_PASSWORD, undefined as unknown as string), false);
    assert.equal(await verifyPassword(undefined as unknown as string, 'x'), false);
  });

  it('截断过的哈希（长度不符）也不会通过', async () => {
    const stored = await hashPassword(GOOD_PASSWORD);
    const [prefix, N, r, p, salt, key] = stored.split('$');
    const truncated = [prefix, N, r, p, salt, key.slice(0, 20)].join('$');
    assert.equal(await verifyPassword(GOOD_PASSWORD, truncated), false);
  });

  it('用户不存在时用的 DUMMY_HASH 不会误判通过', async () => {
    assert.equal(await verifyPassword(GOOD_PASSWORD, DUMMY_HASH), false);
    assert.equal(await verifyPassword('', DUMMY_HASH), false);
  });

  it('口令策略：太短、太长、太简单、非字符串都被拒', async () => {
    assert.throws(() => assertPasswordPolicy('short'), PasswordPolicyError);
    assert.throws(() => assertPasswordPolicy('a'.repeat(PASSWORD_MAX_LENGTH + 1)), PasswordPolicyError);
    assert.throws(() => assertPasswordPolicy('aaaaaaaaaaaa'), PasswordPolicyError);
    assert.throws(() => assertPasswordPolicy(undefined as unknown as string), PasswordPolicyError);
    await assert.rejects(hashPassword('short'), PasswordPolicyError);
    assert.equal(assertPasswordPolicy(GOOD_PASSWORD), undefined);
    // 恰好卡在边界上的长度应当通过
    const maxLength = 'a1b2c3d4e5'.repeat(20); // 200 字符、字符集足够
    assert.equal(maxLength.length, PASSWORD_MAX_LENGTH);
    const stored = await hashPassword(maxLength);
    assert.equal(await verifyPassword(maxLength, stored), true);
  });
});

describe('访问令牌：HS256 签发与校验', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const now = new Date('2026-09-10T12:00:00Z');

  it('签发的令牌能校验通过，并带回 sub / sid / iat / exp', () => {
    const token = signAccessToken(userId, sessionId, SECRET, ACCESS_TOKEN_TTL_SECONDS, now);
    const claims = verifyAccessToken(token, SECRET, now);
    assert.ok(claims);
    assert.equal(claims.sub, userId);
    assert.equal(claims.sid, sessionId);
    assert.equal(claims.iat, Math.floor(now.getTime() / 1000));
    assert.equal(claims.exp, claims.iat + ACCESS_TOKEN_TTL_SECONDS);
  });

  it('过期即失效（exp 必须严格大于当前时刻）', () => {
    const token = signAccessToken(userId, sessionId, SECRET, 10, now);
    const justBefore = new Date(now.getTime() + 9_000);
    const atExpiry = new Date(now.getTime() + 10_000);
    const after = new Date(now.getTime() + 11_000);
    assert.ok(verifyAccessToken(token, SECRET, justBefore));
    assert.equal(verifyAccessToken(token, SECRET, atExpiry), null);
    assert.equal(verifyAccessToken(token, SECRET, after), null);
  });

  it('改过 payload 的令牌失效', () => {
    const token = signAccessToken(userId, sessionId, SECRET, 900, now);
    const [header, , signature] = token.split('.');
    const forgedClaims = b64url({ sub: 'attacker', sid: sessionId, iat: 0, exp: 9_999_999_999 });
    assert.equal(verifyAccessToken(`${header}.${forgedClaims}.${signature}`, SECRET, now), null);
  });

  it('改过签名的令牌失效', () => {
    const token = signAccessToken(userId, sessionId, SECRET, 900, now);
    const [header, claims, signature] = token.split('.');
    const flipped = signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A');
    assert.equal(verifyAccessToken(`${header}.${claims}.${flipped}`, SECRET, now), null);
  });

  it('alg=none 的降级尝试被拒', () => {
    const claims = b64url({ sub: userId, sid: sessionId, iat: 0, exp: 9_999_999_999 });
    const noneHeader = b64url({ alg: 'none', typ: 'JWT' });
    assert.equal(verifyAccessToken(`${noneHeader}.${claims}.`, SECRET, now), null);
    assert.equal(verifyAccessToken(`${noneHeader}.${claims}.${b64url({})}`, SECRET, now), null);
  });

  it('换密钥、缺字段、格式错误的令牌都被拒', () => {
    const token = signAccessToken(userId, sessionId, SECRET, 900, now);
    assert.equal(verifyAccessToken(token, 'another-secret', now), null);
    assert.equal(verifyAccessToken('', SECRET, now), null);
    assert.equal(verifyAccessToken('a.b', SECRET, now), null);
    assert.equal(verifyAccessToken('a.b.c.d', SECRET, now), null);
    assert.equal(verifyAccessToken(`${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: userId })}.AAAA`, SECRET, now), null);
    assert.equal(verifyAccessToken(undefined as unknown as string, SECRET, now), null);

    const header = b64url({ alg: 'HS256', typ: 'JWT' });
    const missingSid = b64url({ sub: userId, iat: 0, exp: 9_999_999_999 });
    assert.equal(verifyAccessToken(`${header}.${missingSid}.AAAA`, SECRET, now), null);
  });

  it('nbf 在未来太远时拒绝，容许时钟偏差', async () => {
    const { createHmac } = await import('node:crypto');
    const base = Math.floor(now.getTime() / 1000);
    const header = b64url({ alg: 'HS256', typ: 'JWT' });
    const sign = (claims: Record<string, unknown>): string => {
      const signingInput = `${header}.${b64url(claims)}`;
      return `${signingInput}.${createHmac('sha256', SECRET).update(signingInput).digest('base64url')}`;
    };
    const soon = sign({ sub: userId, sid: sessionId, iat: base, exp: base + 900, nbf: base + 30 });
    const farFuture = sign({ sub: userId, sid: sessionId, iat: base, exp: base + 900, nbf: base + 3600 });
    assert.ok(verifyAccessToken(soon, SECRET, now));
    assert.equal(verifyAccessToken(farFuture, SECRET, now), null);
  });

  it('不同用户/会话签出的令牌互不相同；空密钥直接报错', () => {
    const a = signAccessToken(userId, sessionId, SECRET, 900, now);
    const b = signAccessToken(userId, newSessionId(), SECRET, 900, now);
    assert.notEqual(a, b);
    assert.throws(() => signAccessToken(userId, sessionId, ''), /JWT_SECRET/);
  });
});

describe('刷新令牌', () => {
  it('生成高熵随机串，库里只存 SHA-256 哈希', () => {
    const first = createRefreshToken();
    const second = createRefreshToken();
    assert.notEqual(first.token, second.token);
    assert.ok(first.token.length >= 43, '32 字节 base64url 至少 43 字符');
    assert.match(first.hash, /^[0-9a-f]{64}$/);
    assert.equal(first.hash, hashRefreshToken(first.token));
    assert.notEqual(first.hash, first.token);
  });

  it('有效期默认 30 天', () => {
    const now = new Date('2026-09-10T00:00:00Z');
    const expires = refreshTokenExpiresAt(now);
    assert.equal(expires.getTime() - now.getTime(), REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  });

  it('会话 id 是 UUID 且互不相同', () => {
    const a = newSessionId();
    const b = newSessionId();
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(a, b);
  });
});

describe('用户名规则', () => {
  it('统一归一化为小写去空格', () => {
    assert.equal(normalizeUsername('  GetL  '), 'getl');
    assert.equal(normalizeUsername('AB_C-1'), 'ab_c-1');
    assert.equal(normalizeUsername(undefined as unknown as string), '');
  });

  it('合法与非法用户名', () => {
    for (const good of ['getl', 'GetL', ' ab_c ', 'user-1', 'a'.repeat(32)]) {
      assert.equal(isValidUsername(good), true, `应接受：${good}`);
    }
    for (const bad of ['', 'ab', 'a'.repeat(33), '中文名', 'a b', 'a@b', 'a.b', '-', 'a$b']) {
      assert.equal(isValidUsername(bad), false, `应拒绝：${bad}`);
    }
  });
});
