/**
 * Web Push 发送（薄包装 web-push，方便在测试里换成假实现）。
 *
 * 返回值刻意分成三态：
 *  - sent：已交给推送服务
 *  - gone：订阅已失效（404/410）→ 调用方应立即禁用它，别再重试
 *  - failed：暂时性失败 → 可以重试
 */
import webpush from 'web-push';

import type { PushSubscriptionRecord } from './notifications.ts';

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export type PushResult =
  | { status: 'sent' }
  | { status: 'gone'; error: string }
  | { status: 'failed'; error: string };

export interface PushSender {
  send(subscription: PushSubscriptionRecord, payload: PushPayload): Promise<PushResult>;
}

/**
 * 把 web-push 抛出的错误分成三态。抽成纯函数是为了能单测：
 * 真实推送服务才会回 404/410，本地编不出来。
 */
export function classifyPushError(error: unknown): PushResult {
  const statusCode = (error as { statusCode?: number }).statusCode;
  const message = error instanceof Error ? error.message : String(error);
  if (statusCode === 404 || statusCode === 410) return { status: 'gone', error: `HTTP ${statusCode}` };
  return { status: 'failed', error: statusCode ? `HTTP ${statusCode}: ${message}` : message };
}

export interface PushSenderOptions {
  publicKey: string;
  privateKey: string;
  subject: string;
  /** 推送服务会保留多久（秒）；默认 12 小时，够覆盖"当天送达" */
  ttlSeconds?: number;
}

export function createPushSender(options: PushSenderOptions): PushSender {
  webpush.setVapidDetails(options.subject, options.publicKey, options.privateKey);

  return {
    async send(subscription, payload): Promise<PushResult> {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(payload),
          { TTL: options.ttlSeconds ?? 12 * 60 * 60 },
        );
        return { status: 'sent' };
      } catch (error) {
        return classifyPushError(error);
      }
    },
  };
}
