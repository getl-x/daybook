import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiFetch, loadSession, saveSession } from '../src/lib/api.ts';

test('refresh preserves sessions on network/5xx errors, revokes only invalid tokens, and shares concurrent refreshes', async (t) => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalFetch = globalThis.fetch;
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => {
        items.set(k, v);
      },
      removeItem: (k: string) => {
        items.delete(k);
      },
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const seed = () =>
    saveSession({
      user: { id: 'u', username: 'user' },
      accessToken: 'expired',
      refreshToken: 'valid',
      expiresAt: 0,
      refreshExpiresAt: 'future',
    });
  for (const failure of ['network', 'server', 'invalid']) {
    seed();
    globalThis.fetch = async (url) => {
      if (!String(url).endsWith('/refresh')) return new Response('{}', { status: 401 });
      if (failure === 'network') throw new TypeError('offline');
      return new Response('{}', { status: failure === 'server' ? 503 : 401 });
    };
    await assert.rejects(apiFetch('/v1/diaries/today'));
    assert.equal(loadSession() !== null, failure !== 'invalid');
  }
  seed();
  let refreshes = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/refresh')) {
      refreshes++;
      await new Promise((r) => setTimeout(r, 10));
      return Response.json({
        user: { id: 'u', username: 'user' },
        accessToken: 'new',
        refreshToken: 'next',
        expiresIn: 3600,
        refreshExpiresAt: 'future',
      });
    }
    return new Response('{}', {
      status: new Headers(init?.headers).get('authorization') === 'Bearer new' ? 200 : 401,
    });
  };
  await Promise.all([apiFetch('/v1/diaries/today'), apiFetch('/v1/settings')]);
  assert.equal(refreshes, 1);
  assert.equal(loadSession()?.accessToken, 'new');
});
