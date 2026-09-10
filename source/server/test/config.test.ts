/**
 * 配置解析测试：缺关键项要明确报错，不静默启动。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, DEFAULT_PORT, loadConfig } from '../src/config.ts';

const BASE = {
  DATABASE_URL: 'postgres://daybook:secret@db:5432/daybook',
  JWT_SECRET: 'a'.repeat(32),
};

describe('loadConfig', () => {
  it('端口默认 8090，可用 PORT 覆盖', () => {
    assert.equal(loadConfig({ ...BASE }).port, DEFAULT_PORT);
    assert.equal(DEFAULT_PORT, 8090);
    assert.equal(loadConfig({ ...BASE, PORT: '9000' }).port, 9000);
  });

  it('缺少 DATABASE_URL / JWT_SECRET 时抛出带变量名的 ConfigError', () => {
    assert.throws(
      () => loadConfig({ JWT_SECRET: 'a'.repeat(32) }),
      (error: unknown) => error instanceof ConfigError && /DATABASE_URL/.test((error as Error).message),
    );
    assert.throws(
      () => loadConfig({ DATABASE_URL: BASE.DATABASE_URL }),
      (error: unknown) => error instanceof ConfigError && /JWT_SECRET/.test((error as Error).message),
    );
    assert.throws(() => loadConfig({ ...BASE, DATABASE_URL: '   ' }), ConfigError);
  });

  it('DATABASE_URL 必须是 postgres 连接串', () => {
    assert.throws(() => loadConfig({ ...BASE, DATABASE_URL: 'mysql://x/y' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE, DATABASE_URL: 'daybook' }), ConfigError);
    assert.equal(loadConfig({ ...BASE, DATABASE_URL: 'postgresql://db/daybook' }).databaseUrl, 'postgresql://db/daybook');
  });

  it('PORT 非法直接报错', () => {
    for (const port of ['abc', '0', '70000', '80.5', '-1']) {
      assert.throws(() => loadConfig({ ...BASE, PORT: port }), ConfigError, `应拒绝 PORT=${port}`);
    }
  });

  it('NODE_ENV 只接受三个值；测试环境默认静默日志', () => {
    assert.equal(loadConfig({ ...BASE }).nodeEnv, 'development');
    assert.equal(loadConfig({ ...BASE, NODE_ENV: 'test' }).logLevel, 'silent');
    assert.equal(loadConfig({ ...BASE, NODE_ENV: 'production' }).logLevel, 'info');
    assert.equal(loadConfig({ ...BASE, LOG_LEVEL: 'debug' }).logLevel, 'debug');
    assert.throws(() => loadConfig({ ...BASE, NODE_ENV: 'prod' }), ConfigError);
  });

  it('生产环境的 JWT_SECRET 太短要报错，开发环境不管', () => {
    const short = { ...BASE, JWT_SECRET: 'short' };
    assert.throws(() => loadConfig({ ...short, NODE_ENV: 'production' }), ConfigError);
    assert.equal(loadConfig({ ...short, NODE_ENV: 'development' }).jwtSecret, 'short');
  });

  it('VAPID 要么不配，要么两个都配', () => {
    assert.equal(loadConfig({ ...BASE }).vapid, null);
    assert.throws(() => loadConfig({ ...BASE, VAPID_PUBLIC_KEY: 'pub' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE, VAPID_PRIVATE_KEY: 'priv' }), ConfigError);
    const vapid = loadConfig({ ...BASE, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' });
    assert.deepEqual(vapid.vapid, { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:noreply@localhost' });
    assert.equal(
      loadConfig({ ...BASE, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:me@x.y' }).vapid
        ?.subject,
      'mailto:me@x.y',
    );
  });
});
