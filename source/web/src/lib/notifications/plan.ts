/**
 * 本地提醒排程的**纯逻辑**（不碰 window / localStorage / 任何原生 API）。
 *
 * 目标：把「用户设置里的两个提醒时间」翻译成未来 N 天、逐条带 `fireAt` 的
 * 通知槽位。时区与日界算法全部复用 `@daybook/shared`（与后端 Web Push 排程
 * 同一套规则），这样 APK 的本地提醒和浏览器里的 Web Push 落在同一天、同一时刻。
 *
 * 之所以把这些逻辑单独放一个模块：这样它能在 `node --test` 里直接跑（无 DOM），
 * 原生层（./native.ts）只负责把这里算出来的槽位喂给 Capacitor。
 */
import { addDays, diaryDate, resolveLocal } from '@daybook/shared';

/** 与后端 snake_case 解耦后的提醒设置（web 侧内部形状）。 */
export interface ReminderSettings {
  morningEnabled: boolean;
  morningTime: string;
  eveningEnabled: boolean;
  eveningTime: string;
  dayStartHour: number;
  timezone: string;
}

export type ReminderKind = 'morning' | 'evening';

export interface ReminderSlot {
  /** 稳定键：`<kind>:<entryDate>`，同一日记日的同一类提醒永远同一个键。 */
  key: string;
  /** Android 通知 id（由 key 决定，稳定且 < 2**31）。 */
  id: number;
  kind: ReminderKind;
  /** 该提醒归属的「日记日」（考虑日界：03:30 的提醒算前一天）。 */
  entryDate: string;
  fireAt: Date;
}

/** 槽位键（kind + 日记日）：幂等排程的依据。 */
export function slotKey(kind: ReminderKind, entryDate: string): string {
  return `${kind}:${entryDate}`;
}

/**
 * FNV-1a 32 位哈希，再抹掉符号位，得到稳定、非负、< 2**31 的整数 id。
 * Android 通知 id 是 32 位有符号整数，所以必须落在 [1, 2**31)。
 */
export function slotId(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // 抹掉符号位；hash 恰为 0 的极端情况兜底成 1，保证是正整数。
  return (hash & 0x7fffffff) || 1;
}

export interface PlanRemindersInput {
  settings: ReminderSettings;
  now: Date;
  /** 往后排几天（默认 90）。 */
  days?: number;
}

/**
 * 从「当前日记日」起逐日生成提醒槽位：
 *  - 只生成打开的 kind；
 *  - `fireAt` 用 `resolveLocal`（DST 安全：跳变那天顺延、回拨取较早）；
 *  - `entryDate` 用 `diaryDate`（考虑日界，凌晨的提醒算前一天）；
 *  - 丢弃 `fireAt <= now` 的槽位（已经过去的不再排）；
 *  - 结果按 `fireAt` 升序。
 */
export function planReminders({ settings, now, days = 90 }: PlanRemindersInput): ReminderSlot[] {
  const active: { kind: ReminderKind; time: string }[] = [];
  if (settings.morningEnabled) active.push({ kind: 'morning', time: settings.morningTime });
  if (settings.eveningEnabled) active.push({ kind: 'evening', time: settings.eveningTime });

  const slots: ReminderSlot[] = [];
  if (active.length === 0) return slots;

  const startDate = diaryDate(now, settings.timezone, settings.dayStartHour);
  const nowMs = now.getTime();

  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(startDate, offset);
    for (const { kind, time } of active) {
      const fireAt = resolveLocal(date, time, settings.timezone);
      if (fireAt.getTime() <= nowMs) continue;
      const entryDate = diaryDate(fireAt, settings.timezone, settings.dayStartHour);
      const key = slotKey(kind, entryDate);
      slots.push({ key, id: slotId(key), kind, entryDate, fireAt });
    }
  }

  slots.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
  return slots;
}

export interface SlotSummary {
  count: number;
  firstAt: Date | null;
  lastAt: Date | null;
}

/** 汇总：条数 + 最早/最晚触发时刻（空时都是 null）。 */
export function summarizeSlots(slots: ReminderSlot[]): SlotSummary {
  if (slots.length === 0) return { count: 0, firstAt: null, lastAt: null };

  let firstMs = slots[0]!.fireAt.getTime();
  let lastMs = firstMs;
  for (const slot of slots) {
    const ms = slot.fireAt.getTime();
    if (ms < firstMs) firstMs = ms;
    if (ms > lastMs) lastMs = ms;
  }
  return { count: slots.length, firstAt: new Date(firstMs), lastAt: new Date(lastMs) };
}

/** 后端 `SettingsView` 里提醒相关字段的最小形状（只取这里用得到的）。 */
export interface ReminderSettingsView {
  timezone: string;
  day_start_hour: number;
  reminders: {
    morning_enabled: boolean;
    morning_time: string;
    evening_enabled: boolean;
    evening_time: string;
  };
}

/** 后端 snake_case → web 侧 camelCase（解耦后端字段名）。 */
export function toReminderSettings(view: ReminderSettingsView): ReminderSettings {
  return {
    morningEnabled: view.reminders.morning_enabled,
    morningTime: view.reminders.morning_time,
    eveningEnabled: view.reminders.evening_enabled,
    eveningTime: view.reminders.evening_time,
    dayStartHour: view.day_start_hour,
    timezone: view.timezone,
  };
}
