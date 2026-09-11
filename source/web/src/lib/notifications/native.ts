/**
 * 原生层（Capacitor Android 壳）：把 planner 算出的槽位登记成本地通知。
 *
 * 三条硬约束（保证浏览器里的 PWA 行为一字不变）：
 *  1. 每个函数入口都先 `isNativeShell()` 守卫，不是原生壳就直接返回；
 *  2. Capacitor 插件一律用 `await import(...)` **动态引入**——浏览器构建产物里
 *     不会静态打包插件代码，插件只在原生壳里真正加载；
 *  3. 全部 `try/catch` 兜底，任何原生异常都不允许冒泡到 UI 层。
 *
 * 设计照抄 lastdone 的做法：App 自己排未来 90 天的**非精确**本地通知
 * （`isExactNotification: false` → 不申请精确闹钟权限、不用 FCM / Google 服务）。
 */
import { isNativeShell } from '../server.ts';
import { navigate } from '../router.ts';
import { planReminders, summarizeSlots, type ReminderSettings } from './plan.ts';

/** 通知渠道 id（v1：改了渠道参数要换 id，否则旧渠道的参数不会更新）。 */
const CHANNEL_ID = 'daybook-reminders-v1';
/** 已登记通知 id 列表的本地缓存（用于下次先取消再重排）。 */
const IDS_KEY = 'daybook.nativeReminders.v1';
/** 给 UI 读的状态快照。 */
const META_KEY = 'daybook.nativeReminders.meta.v1';
/** 排多久。 */
const PLAN_DAYS = 90;
/** 回前台重同步的最小间隔（防抖，避免频繁申请）。 */
const RESYNC_MIN_INTERVAL_MS = 30_000;

/** 通知文案（语气对齐今日页：口语、简短、不催促）。 */
const COPY: Record<'morning' | 'evening', { title: string; body: string }> = {
  morning: { title: '早上好', body: '回顾昨天、安排今天：写两句就够了' },
  evening: { title: '晚上好', body: '写一句今天的小结吧' },
};

export type NativePermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

export interface NativeReminderState {
  permission: string;
  scheduled: number;
  nextAt: string | null;
  lastSyncAt: string | null;
}

export interface SyncResult {
  scheduled: number;
  permission: string;
  firstAt: string | null;
}

function readStoredIds(): number[] {
  try {
    const raw = localStorage.getItem(IDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is number => typeof value === 'number' && Number.isInteger(value));
  } catch {
    return [];
  }
}

function writeStoredIds(ids: number[]): void {
  try {
    localStorage.setItem(IDS_KEY, JSON.stringify(ids));
  } catch {
    // localStorage 不可用：忽略，下次同步会重新排
  }
}

function writeMeta(state: NativeReminderState): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(state));
  } catch {
    // 同上
  }
}

/** 给 UI 读的状态快照（读自缓存；没有就按已登记的 id 数兜底）。 */
export function getNativeReminderState(): NativeReminderState {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<NativeReminderState>;
      return {
        permission: typeof parsed.permission === 'string' ? parsed.permission : 'unknown',
        scheduled: typeof parsed.scheduled === 'number' ? parsed.scheduled : readStoredIds().length,
        nextAt: typeof parsed.nextAt === 'string' ? parsed.nextAt : null,
        lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
      };
    }
  } catch {
    // 落到下面的默认值
  }
  return { permission: 'unknown', scheduled: readStoredIds().length, nextAt: null, lastSyncAt: null };
}

/** 当前通知权限；未决定时弹一次系统授权框。 */
export async function ensureNativePermission(): Promise<NativePermission> {
  if (!isNativeShell()) return 'unsupported';
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const current = await LocalNotifications.checkPermissions();
    if (current.display === 'granted') return 'granted';
    if (current.display === 'denied') return 'denied';
    const requested = await LocalNotifications.requestPermissions();
    if (requested.display === 'granted') return 'granted';
    if (requested.display === 'denied') return 'denied';
    return 'prompt';
  } catch {
    return 'unsupported';
  }
}

/**
 * 按设置重排未来 90 天的本地通知：
 *  建渠道 → 查/申请权限（被拒不取消已有计划）→ 取消上次登记的 id → 批量 schedule → 写回 id。
 */
export async function syncNativeSchedules(settings: ReminderSettings): Promise<SyncResult> {
  const unsupported: SyncResult = { scheduled: 0, permission: 'unsupported', firstAt: null };
  if (!isNativeShell()) return unsupported;

  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');

    // 渠道：importances/visibility 数值以 Capacitor 文档为准（High=4 / Public=1）。
    try {
      await LocalNotifications.createChannel({
        id: CHANNEL_ID,
        name: '日记提醒',
        description: '每天早/晚提醒写下当天的一两句',
        importance: 4,
        visibility: 1,
      });
    } catch {
      // 某些平台没有 createChannel：忽略，schedule 时仍带 channelId
    }

    const permission = await ensureNativePermission();
    if (permission !== 'granted') {
      // 被拒：不取消已有计划（换权限后旧计划还能用），只回报状态。
      return { scheduled: readStoredIds().length, permission, firstAt: null };
    }

    const slots = planReminders({ settings, now: new Date(), days: PLAN_DAYS });

    const previous = readStoredIds();
    if (previous.length > 0) {
      try {
        await LocalNotifications.cancel({ notifications: previous.map((id) => ({ id })) });
      } catch {
        // 取消失败不阻塞重排（id 稳定，schedule 会覆盖同 id）
      }
    }

    if (slots.length > 0) {
      await LocalNotifications.schedule({
        notifications: slots.map((slot) => ({
          id: slot.id,
          title: COPY[slot.kind].title,
          body: COPY[slot.kind].body,
          channelId: CHANNEL_ID,
          smallIcon: 'ic_stat_daybook',
          schedule: { at: slot.fireAt, allowWhileIdle: true },
          // 非精确闹钟：不申请 SCHEDULE_EXACT_ALARM，系统可能稍微推迟。
          isExactNotification: false,
          extra: { entryDate: slot.entryDate, kind: slot.kind },
        })),
      });
    }

    writeStoredIds(slots.map((slot) => slot.id));
    const summary = summarizeSlots(slots);
    const firstAt = summary.firstAt ? summary.firstAt.toISOString() : null;
    writeMeta({
      permission,
      scheduled: slots.length,
      nextAt: firstAt,
      lastSyncAt: new Date().toISOString(),
    });
    return { scheduled: slots.length, permission, firstAt };
  } catch {
    return unsupported;
  }
}

type ListenerHandle = { remove(): Promise<void> };

let cleanup: (() => void) | null = null;

/**
 * 注册原生同步钩子（只在原生壳里生效，重复调用幂等）：
 *  - 注册时同步一次；
 *  - 回前台（`appStateChange.isActive`）重同步（至少间隔 30s，防抖）；
 *  - 点通知 → 跳 `#/today`。
 * 传入 `getSettings` 而不是把设置写死，登出/换用户后由调用方 dispose 再重建。
 */
export function registerNativeSyncHooks(getSettings: () => Promise<ReminderSettings | null>): void {
  if (!isNativeShell()) return;
  if (cleanup) return;

  let disposed = false;
  let running = false;
  let lastSyncAt = 0;
  const handles: ListenerHandle[] = [];

  const resync = async (force = false): Promise<void> => {
    if (disposed || running) return;
    if (!force && Date.now() - lastSyncAt < RESYNC_MIN_INTERVAL_MS) return;
    running = true;
    try {
      const settings = await getSettings();
      if (settings) await syncNativeSchedules(settings);
      lastSyncAt = Date.now();
    } catch {
      // 忽略：下次回前台再试
    } finally {
      running = false;
    }
  };

  void (async () => {
    try {
      const [{ App }, { LocalNotifications }] = await Promise.all([
        import('@capacitor/app'),
        import('@capacitor/local-notifications'),
      ]);
      if (disposed) return;

      handles.push(
        await App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) void resync();
        }),
      );
      handles.push(
        await LocalNotifications.addListener('localNotificationActionPerformed', () => {
          navigate('#/today');
        }),
      );
      void resync(true);
    } catch {
      // 插件缺失 / 非原生：静默
    }
  })();

  cleanup = () => {
    disposed = true;
    for (const handle of handles.splice(0)) void Promise.resolve(handle.remove()).catch(() => undefined);
    cleanup = null;
  };
}

/** 注销同步钩子（登出时调用）。 */
export function disposeNativeSyncHooks(): void {
  cleanup?.();
}
