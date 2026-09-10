/**
 * Web Push 发送器的测试。
 *
 * 为什么把分类抽成纯函数：真实推送服务才会回 404/410，本地编不出来；抽出来就能钉死映射。
 * 另外用真实调用覆盖"发不出去"的两条路径（都不需要外网）：
 *  - `.invalid` 域名（DNS 必失败）→ failed
 *  - 本地不可达端口 → failed
 * 关键点：任何失败都**返回** failed，不把异常抛给调度器。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import webpush from 'web-push';

import type { PushSubscriptionRecord } from '../src/notifications.ts';
import { classifyPushError, createPushSender } from '../src/push.ts';

function subscription(endpoint: string): PushSubscriptionRecord {
  return {
    id: 'sub-1',
    endpoint,
    p256dh: 'BNcRvM5L5p2nS1FhJ0j5G7pQ1k2m3n4o5p6q7r8s9t0',
    auth: 'aBcDeFgHiJkLmNoPqRsTuV',
    userAgent: 'test',
    disabledAt: null,
    failureCount: 0,
    createdAt: new Date('2026-09-10T00:00:00Z'),
  };
}

const PAYLOAD = { title: 'daybook', body: '该写日记了', url: '/#/today', tag: 'daybook' };

describe('classifyPushError：错误 → 三态', () => {
  it('404 / 410 → gone（订阅已失效，应立即禁用）', () => {
    for (const statusCode of [404, 410]) {
      const result = classifyPushError(Object.assign(new Error('push service rejected'), { statusCode }));
      assert.equal(result.status, 'gone');
      assert.equal(result.status === 'gone' ? result.error : '', `HTTP ${statusCode}`);
    }
  });

  it('其他 HTTP 状态 → failed（可重试），带上状态码', () => {
    const result = classifyPushError(Object.assign(new Error('server error'), { statusCode: 500 }));
    assert.equal(result.status, 'failed');
    assert.ok(result.status === 'failed' && result.error.startsWith('HTTP 500:'));
  });

  it('没有状态码（网络/DNS 错误）→ failed，保留原始信息', () => {
    const result = classifyPushError(new Error('getaddrinfo ENOTFOUND push.example.invalid'));
    assert.equal(result.status, 'failed');
    assert.ok(result.status === 'failed' && result.error.includes('ENOTFOUND'));
  });

  it('抛出的不是 Error 也不会炸', () => {
    const result = classifyPushError('something odd');
    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' ? result.error : '', 'something odd');
  });
});

describe('createPushSender：真实调用的失败路径', () => {
  const keys = webpush.generateVAPIDKeys();

  it('.invalid 域名发不出去 → 返回 failed（而不是抛异常）', async () => {
    const sender = createPushSender({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'mailto:dev@daybook.local',
      ttlSeconds: 60,
    });

    const result = await sender.send(subscription('https://push.example.invalid/device-1'), PAYLOAD);
    assert.equal(result.status, 'failed');
    assert.ok(result.status === 'failed' && result.error.length > 0);
  });

  it('宿主不可达（本地保留端口）也算 failed', async () => {
    const sender = createPushSender({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'mailto:dev@daybook.local',
    });

    const result = await sender.send(subscription('https://127.0.0.1:1/device-1'), PAYLOAD);
    assert.equal(result.status, 'failed');
  });
});
