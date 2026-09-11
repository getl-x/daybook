/**
 * CORS：Android APK（Capacitor 壳）里的 WebView 源是 `https://localhost`，
 * 必须显式放行才能调用后端；浏览器里的 PWA 与后端同源（不带 Origin），行为不受影响。
 *
 * 这些用例把"放行谁 / 不放行谁"钉住——名单写宽了等于把接口暴露给任意网页。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildApp } from '../src/app.ts';
import { ConfigError, DEFAULT_CORS_ORIGINS, loadConfig, type Config } from '../src/config.ts';
import { createFakeStore, type FakeStore } from './helpers/fake-store.ts';

const BASE_CONFIG: Config = {
  nodeEnv: 'test',
  port: 8090,
  databaseUrl: 'postgres://daybook:secret@localhost:5432/daybook',
  jwtSecret: 'test-secret-0123456789abcdef',
  logLevel: 'silent',
  vapid: null,
};

function appWith(overrides: Partial<Config> = {}, store: FakeStore = createFakeStore()) {
  return buildApp({
    config: { ...BASE_CONFIG, ...overrides },
    store,
    now: () => new Date('2026-09-10T12:00:00Z'),
  });
}

function allowOrigin(response: { headers: Record<string, unknown> }): string | undefined {
  const value = response.headers['access-control-allow-origin'];
  return value === undefined ? undefined : String(value);
}

describe('CORS（给 Android APK 用）', () => {
  it('默认放行 Capacitor 的 https://localhost', async () => {
    const app = appWith();
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://localhost' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(allowOrigin(response), 'https://localhost');
    await app.close();
  });

  it('默认也放行 capacitor://localhost（iOS 壳将来用）', async () => {
    assert.deepEqual([...DEFAULT_CORS_ORIGINS], ['https://localhost', 'capacitor://localhost']);

    const app = appWith();
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'capacitor://localhost' },
    });
    assert.equal(allowOrigin(response), 'capacitor://localhost');
    await app.close();
  });

  it('预检请求（带 Authorization 的 PATCH）返回 204，并允许 authorization 头', async () => {
    const app = appWith();
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/diaries/2026-09-10',
      headers: {
        origin: 'https://localhost',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization,content-type',
      },
    });

    assert.equal(response.statusCode, 204);
    assert.equal(allowOrigin(response), 'https://localhost');
    assert.match(String(response.headers['access-control-allow-methods']).toUpperCase(), /PATCH/);
    assert.match(String(response.headers['access-control-allow-headers']).toLowerCase(), /authorization/);
    await app.close();
  });

  it('名单外的源拿不到放行头', async () => {
    const app = appWith();
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(allowOrigin(response), undefined);
    await app.close();
  });

  it('不带 Origin 的请求（同源 PWA）照常工作，也不返回放行头', async () => {
    const app = appWith();
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(response.statusCode, 200);
    assert.equal(allowOrigin(response), undefined);
    await app.close();
  });

  it('配置了 corsOrigins 就以配置为准（默认的 https://localhost 被顶掉）', async () => {
    const app = appWith({ corsOrigins: ['https://diary.example.com'] });

    const allowed = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://diary.example.com' },
    });
    assert.equal(allowOrigin(allowed), 'https://diary.example.com');

    const notAllowed = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://localhost' },
    });
    assert.equal(allowOrigin(notAllowed), undefined);
    await app.close();
  });
});

describe('loadConfig 解析 CORS_ORIGINS', () => {
  const baseEnv = {
    DATABASE_URL: 'postgres://daybook:secret@localhost:5432/daybook',
    JWT_SECRET: 'test-secret-0123456789abcdef',
  };

  it('没配就用默认的 Capacitor 源', () => {
    assert.deepEqual([...(loadConfig(baseEnv).corsOrigins ?? [])], [...DEFAULT_CORS_ORIGINS]);
  });

  it('配了就按逗号分隔解析（去空格、忽略空项）', () => {
    const config = loadConfig({ ...baseEnv, CORS_ORIGINS: ' https://a.example , https://b.example , ' });
    assert.deepEqual([...(config.corsOrigins ?? [])], ['https://a.example', 'https://b.example']);
  });

  it('出现不合法的源就报错（不静默放行）', () => {
    assert.throws(() => loadConfig({ ...baseEnv, CORS_ORIGINS: 'not a url' }), ConfigError);
    assert.throws(() => loadConfig({ ...baseEnv, CORS_ORIGINS: 'https://a.example,ftp://b' }), ConfigError);
  });
});
