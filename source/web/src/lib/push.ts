/**
 * Web Push 订阅：申请权限 → 订阅 → 上报服务端（deletable）。
 *
 * 注意 iOS 的硬约束（计划 §8.3）：
 *  - 必须是"添加到主屏幕"的 Web App 才能收到推送；
 *  - 授权请求必须由用户手势触发（所以这里必须由按钮调用）。
 */
import { apiFetch } from './api.ts';

export type PushSubscribeResult =
  | { ok: true; subscriptionId: string }
  | { ok: false; reason: 'insecure' | 'unsupported' | 'denied' | 'failed'; message: string };

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  );
}

export interface DeviceDescription {
  /** 人类可读的设备名，例：“iPhone · Safari” */
  label: string;
  /** 平台：ios-pwa（iPhone/iPad）或 web */
  platform: 'ios-pwa' | 'web';
}

const DEVICE_LABEL_MAX = 40;

/**
 * 按 UA 字符串推断当前设备名与平台（纯函数，方便单测）。
 * label 尽量拼成“设备 · 浏览器”，拿不准就退回截断的整个 UA；
 * platform：iPhone/iPad/iPod → ios-pwa，其余 → web。
 * 不传参时用运行环境的 navigator.userAgent。
 */
export function describeCurrentDevice(userAgent?: string): DeviceDescription {
  const ua = (userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')) || '';
  const platform: DeviceDescription['platform'] = /iPhone|iPad|iPod/i.test(ua) ? 'ios-pwa' : 'web';

  let device = '';
  if (/iPhone/i.test(ua)) device = 'iPhone';
  else if (/iPad/i.test(ua)) device = 'iPad';
  else if (/iPod/i.test(ua)) device = 'iPod';
  else if (/Android/i.test(ua)) device = 'Android';
  else if (/Windows/i.test(ua)) device = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) device = 'Mac';
  else if (/Linux/i.test(ua)) device = 'Linux';

  let browser = '';
  if (/Edg(e|iOS)?\//i.test(ua)) browser = 'Edge';
  else if (/CriOS\//i.test(ua)) browser = 'Chrome';
  else if (/FxiOS\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';

  const label = device && browser ? `${device} · ${browser}` : (device || browser || ua).slice(0, DEVICE_LABEL_MAX);
  return { label, platform };
}

/**
 * VAPID 公钥是 base64url，`applicationServerKey` 要 BufferSource。
 * 返回 `ArrayBuffer` 而不是 `Uint8Array`：后者的泛型参数是 ArrayBufferLike，
 * 在 TS 5.9 + lib.dom 下会和 `BufferSource` 的 ArrayBuffer 约束打架。
 */
export function base64UrlToArrayBuffer(base64Url: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let index = 0; index < raw.length; index += 1) view[index] = raw.charCodeAt(index);
  return buffer;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return await navigator.serviceWorker.ready;
}

export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscribeResult> {
  if (!window.isSecureContext) {
    return { ok: false, reason: 'insecure', message: '需要 HTTPS（或 localhost）才能订阅推送' };
  }
  if (!pushSupported()) {
    return { ok: false, reason: 'unsupported', message: '这个浏览器不支持网页推送' };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, reason: 'denied', message: '没有拿到通知权限，可以在系统设置里手动允许后再试' };
  }

  try {
    const ready = await registration();
    const existing = await ready.pushManager.getSubscription();
    const subscription =
      existing ??
      (await ready.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToArrayBuffer(vapidPublicKey),
      }));

    const json = subscription.toJSON() as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
      return { ok: false, reason: 'failed', message: '浏览器返回的订阅信息不完整' };
    }

    const response = await apiFetch('/v1/notifications/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        // 让服务端能把这台设备认出来，并在设置页单独开关
        ...describeCurrentDevice(),
      }),
    });
    const body = (await response.json()) as { subscription?: { id?: string } };
    return { ok: true, subscriptionId: body.subscription?.id ?? '' };
  } catch (error) {
    return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : '订阅失败' };
  }
}

/** 取消订阅：先删服务端记录，再让浏览器取消（顺序反过来就拿不到 endpoint 了） */
export async function unsubscribeFromPush(subscriptionId: string): Promise<void> {
  await apiFetch(`/v1/notifications/subscriptions/${subscriptionId}`, { method: 'DELETE' });
  try {
    const ready = await registration();
    const subscription = await ready.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    // 浏览器侧取消失败不影响服务端已经删掉这件事
  }
}
