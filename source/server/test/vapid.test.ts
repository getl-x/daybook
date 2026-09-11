/**
 * VAPID 密钥自动生成：环境变量优先 > 数据库已存 > 生成并入库。
 * 用内存 store 单测解析逻辑，不碰数据库。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_VAPID_SUBJECT, VAPID_SETTING_KEY, resolveVapidKeys } from '../src/vapid.ts';

function memStore(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    store: {
      async getAppSetting(key: string): Promise<string | null> {
        return map.get(key) ?? null;
      },
      async setAppSetting(key: string, value: string): Promise<void> {
        map.set(key, value);
      },
    },
  };
}

describe('resolveVapidKeys', () => {
  it('环境变量优先：直接用，不碰数据库', async () => {
    const { store, map } = memStore();
    const envVapid = { publicKey: 'env-pub', privateKey: 'env-priv', subject: 'mailto:env@x' };
    const logs: string[] = [];
    const result = await resolveVapidKeys({
      envVapid,
      subject: 'mailto:ignored@x',
      store,
      log: (_level, message) => logs.push(message),
    });
    assert.deepEqual(result, envVapid);
    assert.equal(map.size, 0, '不该写库');
    assert.ok(
      logs.some((line) => line.includes('环境变量')),
      '应说明用的是环境变量',
    );
  });

  it('无 env 时读数据库里已保存的密钥，且不改动它', async () => {
    const stored = JSON.stringify({ publicKey: 'db-pub', privateKey: 'db-priv' });
    const { store, map } = memStore({ [VAPID_SETTING_KEY]: stored });
    const logs: string[] = [];
    const result = await resolveVapidKeys({
      envVapid: null,
      subject: 'mailto:me@x',
      store,
      log: (_level, message) => logs.push(message),
    });
    assert.deepEqual(result, { publicKey: 'db-pub', privateKey: 'db-priv', subject: 'mailto:me@x' });
    assert.equal(map.get(VAPID_SETTING_KEY), stored, '已有的值不该被改动');
    assert.ok(logs.some((line) => line.includes('数据库中已保存')));
  });

  it('无 env 且库里没有 → 生成一对并写库；第二次读回同一对（幂等复用）', async () => {
    const { store, map } = memStore();
    const logs: string[] = [];
    const first = await resolveVapidKeys({
      envVapid: null,
      store,
      log: (_level, message) => logs.push(message),
    });
    assert.ok(first.publicKey.length > 0 && first.privateKey.length > 0);
    assert.equal(first.subject, DEFAULT_VAPID_SUBJECT, '没给 subject 时用默认值');
    assert.ok(map.has(VAPID_SETTING_KEY), '应把生成的密钥写进数据库');
    assert.ok(logs.some((line) => line.includes('自动生成')));

    const second = await resolveVapidKeys({ envVapid: null, store });
    assert.deepEqual(second, first, '第二次应读回存储的那一对，而不是再生成');
  });

  it('库里存了非法 JSON → 重新生成并覆盖', async () => {
    const { store, map } = memStore({ [VAPID_SETTING_KEY]: '{ not json' });
    const logs: string[] = [];
    const result = await resolveVapidKeys({
      envVapid: null,
      store,
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    assert.ok(result.publicKey.length > 0 && result.privateKey.length > 0);
    assert.notEqual(map.get(VAPID_SETTING_KEY), '{ not json');
    assert.deepEqual(JSON.parse(map.get(VAPID_SETTING_KEY) ?? '') , {
      publicKey: result.publicKey,
      privateKey: result.privateKey,
    });
    assert.ok(logs.some((line) => line.includes('不是合法 JSON')));
  });
});
