/**
 * 设置与推送订阅接口（单独成文件，app.ts 已经够长）。
 *
 * 认证复用 app.ts 里的 `authenticate`（由 buildApp 传入），因此这里不重复实现令牌校验。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AppStore, AuthContext } from './app.ts';
import type { Config } from './config.ts';
import { DiaryError } from './diary.ts';
import {
  isSubscriptionPlatform,
  normalizeLocalTime,
  SUBSCRIPTION_LABEL_MAX,
  SUBSCRIPTION_PLATFORMS,
  type NotificationStore,
  type PushSubscriptionRecord,
  type ReminderSettings,
} from './notifications.ts';
import { rescheduleUser } from './scheduler.ts';
import { isValidTimeZone } from '@daybook/shared';

export interface NotificationRouteDeps {
  store: AppStore & NotificationStore;
  config: Config;
  now(): Date;
  authenticate(request: FastifyRequest): Promise<AuthContext>;
}

interface SettingsBody {
  timezone?: unknown;
  day_start_hour?: unknown;
  reminder_morning_enabled?: unknown;
  reminder_morning_time?: unknown;
  reminder_evening_enabled?: unknown;
  reminder_evening_time?: unknown;
  reminder_only_if_incomplete?: unknown;
  quiet_enabled?: unknown;
  quiet_start?: unknown;
  quiet_end?: unknown;
}

interface SubscriptionBody {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
  label?: unknown;
  platform?: unknown;
}

const TIMEZONE_PATTERN = /^[A-Za-z_]+\/[A-Za-z_+\-0-9]+$/;

/** 前端需要的设置视图（含推送能力是否就绪） */
function toSettingsView(settings: ReminderSettings, config: Config, subscriptionCount: number) {
  return {
    timezone: settings.timezone,
    day_start_hour: settings.dayStartHour,
    reminders: {
      morning_enabled: settings.morningReminderEnabled,
      morning_time: settings.morningReminderTime,
      evening_enabled: settings.eveningReminderEnabled,
      evening_time: settings.eveningReminderTime,
      only_if_incomplete: settings.notifyOnlyIfIncomplete,
    },
    quiet_hours: {
      enabled: settings.quietHours.enabled,
      start: settings.quietHours.start,
      end: settings.quietHours.end,
    },
    push: {
      /** 没配 VAPID 时前端就不显示"开启提醒"按钮 */
      vapid_public_key: config.vapid?.publicKey ?? null,
      subscriptions: subscriptionCount,
    },
  };
}

export function registerNotificationRoutes(app: FastifyInstance, deps: NotificationRouteDeps): void {
  const { store, config, now, authenticate } = deps;

  /** 设备订阅的对外视图：enabled 由 disabled_at 派生（复用既有启停列，不多加一列） */
  function toSubscriptionView(subscription: PushSubscriptionRecord) {
    return {
      id: subscription.id,
      label: subscription.label,
      platform: subscription.platform,
      enabled: subscription.disabledAt === null,
      created_at: subscription.createdAt.toISOString(),
      failure_count: subscription.failureCount,
    };
  }

  /* ------------------------------- 设置 ------------------------------- */

  app.get('/v1/settings', async (request) => {
    const auth = await authenticate(request);
    // 顺手自愈：老用户可能还没有排程行（提醒功能是后加的），读设置时补上
    const settings = await rescheduleUser(store, auth.userId, now());
    const subscriptions = await store.listAllPushSubscriptions(auth.userId);
    return toSettingsView(settings, config, subscriptions.length);
  });

  /**
   * 更新设置：时区、日界、提醒开关与时间。
   * 改动提醒相关字段会**立即重算排程**（不用等下一次 tick）。
   */
  app.patch('/v1/settings', async (request, reply) => {
    const auth = await authenticate(request);
    const body = (request.body ?? {}) as SettingsBody;

    const patch: Parameters<NotificationStore['updateReminderSettings']>[1] = {};
    let touchesSchedule = false;

    try {
      if (body.timezone !== undefined) {
        // 必须真查一次 Intl 而不是只看格式：`Asia/Beijing` 这种"长得对但不存在"的名字
        // 一旦落库，之后每次算日记日都会抛 RangeError（接口 500、提醒也发不出去）。
        if (typeof body.timezone !== 'string' || !TIMEZONE_PATTERN.test(body.timezone) || !isValidTimeZone(body.timezone)) {
          reply.code(400);
          return { error: 'invalid_field', message: 'timezone 必须是有效的 IANA 名称，例如 Asia/Shanghai' };
        }
        patch.timezone = body.timezone;
        touchesSchedule = true;
      }
      if (body.day_start_hour !== undefined) {
        // 只接受数字或纯数字字符串：`Number(true)` 会静默变成 1，那是会写进库的脏数据
        const raw = body.day_start_hour;
        const hour =
          typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isInteger(hour) || hour < 0 || hour > 6) {
          reply.code(400);
          return { error: 'invalid_field', message: 'day_start_hour 必须是 0–6 的整数' };
        }
        patch.dayStartHour = hour;
        touchesSchedule = true;
      }
      if (body.reminder_morning_enabled !== undefined) {
        patch.morningReminderEnabled = Boolean(body.reminder_morning_enabled);
        touchesSchedule = true;
      }
      if (body.reminder_evening_enabled !== undefined) {
        patch.eveningReminderEnabled = Boolean(body.reminder_evening_enabled);
        touchesSchedule = true;
      }
      if (body.reminder_morning_time !== undefined) {
        patch.morningReminderTime = normalizeLocalTime(body.reminder_morning_time, 'reminder_morning_time');
        touchesSchedule = true;
      }
      if (body.reminder_evening_time !== undefined) {
        patch.eveningReminderTime = normalizeLocalTime(body.reminder_evening_time, 'reminder_evening_time');
        touchesSchedule = true;
      }
      if (body.reminder_only_if_incomplete !== undefined) {
        patch.notifyOnlyIfIncomplete = Boolean(body.reminder_only_if_incomplete);
      }
      if (body.quiet_enabled !== undefined) {
        patch.quietEnabled = Boolean(body.quiet_enabled);
        touchesSchedule = true;
      }
      if (body.quiet_start !== undefined) {
        patch.quietStart = normalizeLocalTime(body.quiet_start, 'quiet_start');
        touchesSchedule = true;
      }
      if (body.quiet_end !== undefined) {
        patch.quietEnd = normalizeLocalTime(body.quiet_end, 'quiet_end');
        touchesSchedule = true;
      }
    } catch (error) {
      if (error instanceof DiaryError) {
        reply.code(400);
        return { error: error.code, message: error.message };
      }
      throw error;
    }

    if (Object.keys(patch).length === 0) {
      reply.code(400);
      return { error: 'no_changes' };
    }

    // 静默时段跨字段校验：用「当前设置 + 本次补丁」算有效值——
    // 开启时两端都必须有且不相等（只在本次有改动时才校验，避免误伤无关 patch）。
    if (
      patch.quietEnabled !== undefined ||
      patch.quietStart !== undefined ||
      patch.quietEnd !== undefined
    ) {
      const current = await store.getReminderSettings(auth.userId);
      const enabled = patch.quietEnabled ?? current.quietHours.enabled;
      const start = patch.quietStart ?? current.quietHours.start;
      const end = patch.quietEnd ?? current.quietHours.end;
      if (enabled) {
        if (start === '' || end === '') {
          reply.code(400);
          return { error: 'invalid_field', message: 'quiet_hours 开启时 quiet_start 与 quiet_end 都必须提供' };
        }
        if (start === end) {
          reply.code(400);
          return { error: 'invalid_field', message: 'quiet_start 与 quiet_end 不能相同' };
        }
      }
    }

    const settings = await store.updateReminderSettings(auth.userId, patch);
    if (touchesSchedule) await rescheduleUser(store, auth.userId, now());

    const subscriptions = await store.listAllPushSubscriptions(auth.userId);
    return toSettingsView(settings, config, subscriptions.length);
  });

  /* ------------------------------ 推送订阅 ----------------------------- */

  /** 订阅（也当心跳用）：endpoint 唯一，重复上报就是刷新 last_seen_at */
  app.post('/v1/notifications/subscriptions', async (request, reply) => {
    const auth = await authenticate(request);
    const body = (request.body ?? {}) as SubscriptionBody;

    const endpoint = body.endpoint;
    const p256dh = body.keys?.p256dh;
    const authKey = body.keys?.auth;
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) {
      reply.code(400);
      return { error: 'invalid_field', message: 'endpoint 必须是 https 地址' };
    }
    if (typeof p256dh !== 'string' || typeof authKey !== 'string' || p256dh === '' || authKey === '') {
      reply.code(400);
      return { error: 'invalid_field', message: 'keys.p256dh 与 keys.auth 必填' };
    }

    // 设备名：可选；超长截断到 40 字符，空白视为未提供
    let label: string | null = null;
    if (body.label !== undefined && body.label !== null) {
      if (typeof body.label !== 'string') {
        reply.code(400);
        return { error: 'invalid_field', message: 'label 必须是字符串' };
      }
      const trimmed = body.label.trim();
      label = trimmed === '' ? null : trimmed.slice(0, SUBSCRIPTION_LABEL_MAX);
    }
    // 平台：可选；只接受白名单，非法就 400
    let platform: string | null = null;
    if (body.platform !== undefined && body.platform !== null) {
      if (!isSubscriptionPlatform(body.platform)) {
        reply.code(400);
        return {
          error: 'invalid_field',
          message: `platform 必须是 ${SUBSCRIPTION_PLATFORMS.join(' / ')} 之一`,
        };
      }
      platform = body.platform;
    }

    const userAgent = typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'].slice(0, 300) : null;
    const subscription = await store.upsertPushSubscription(auth.userId, {
      endpoint,
      p256dh,
      auth: authKey,
      userAgent,
      label,
      platform,
    });

    const settings = await store.getReminderSettings(auth.userId);
    // 第一次订阅时排程可能还没建（例如用户从没打开过设置页）→ 顺手补上
    await rescheduleUser(store, auth.userId, now());

    const subscriptions = await store.listAllPushSubscriptions(auth.userId);
    return {
      subscription: toSubscriptionView(subscription),
      settings: toSettingsView(settings, config, subscriptions.length),
    };
  });

  /** 设备列表：每条含 label / platform / enabled，供设置页展示与单独开关 */
  app.get('/v1/notifications/subscriptions', async (request) => {
    const auth = await authenticate(request);
    const subscriptions = await store.listAllPushSubscriptions(auth.userId);
    return { subscriptions: subscriptions.map(toSubscriptionView) };
  });

  /** 单独启用/停用某台设备（幂等）；不属于当前用户或不存在 → 404 */
  app.patch<{ Params: { id: string } }>('/v1/notifications/subscriptions/:id', async (request, reply) => {
    const auth = await authenticate(request);
    const body = (request.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      reply.code(400);
      return { error: 'invalid_field', message: 'enabled 必须是布尔值' };
    }

    const updated = await store.setSubscriptionEnabled(auth.userId, request.params.id, body.enabled);
    if (!updated) {
      reply.code(404);
      return { error: 'not_found' };
    }

    const subscriptions = await store.listAllPushSubscriptions(auth.userId);
    const subscription = subscriptions.find((item) => item.id === request.params.id);
    if (!subscription) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return { subscription: toSubscriptionView(subscription) };
  });

  app.delete<{ Params: { id: string } }>('/v1/notifications/subscriptions/:id', async (request, reply) => {
    const auth = await authenticate(request);
    const deleted = await store.deletePushSubscription(auth.userId, request.params.id);
    if (!deleted) {
      reply.code(404);
      return { error: 'not_found' };
    }
    reply.code(204);
    return null;
  });

  /** 当前状态：有几台设备订阅了、最近几次提醒的结果、VAPID 公钥 */
  app.get('/v1/notifications/status', async (request) => {
    const auth = await authenticate(request);
    const [subscriptions, deliveries, settings] = await Promise.all([
      store.listAllPushSubscriptions(auth.userId),
      store.listReminderDeliveries(auth.userId, 10),
      store.getReminderSettings(auth.userId),
    ]);

    return {
      vapid_public_key: config.vapid?.publicKey ?? null,
      push_configured: config.vapid !== null,
      subscriptions: subscriptions.map(toSubscriptionView),
      recent_deliveries: deliveries.map((delivery) => ({
        local_date: delivery.localDate,
        kind: delivery.kind,
        status: delivery.status,
        attempts: delivery.attempts,
        last_error: delivery.lastError,
      })),
      reminders: {
        morning_time: settings.morningReminderTime,
        evening_time: settings.eveningReminderTime,
      },
    };
  });

  /** 设置页的时区下拉：直接用运行环境的 IANA 列表（Node 内置）。要登录才给看。 */
  app.get('/v1/meta/timezones', async (request) => {
    await authenticate(request);
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.('timeZone');
    return { timezones: supported ?? [] };
  });
}
