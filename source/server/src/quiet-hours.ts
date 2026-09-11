/**
 * 静默时段（quiet hours）：落在 [start, end) 内的提醒推迟到窗口结束。
 *
 * 纯函数：时区 / 日界 / DST 全部交给 @daybook/shared 的时区工具算，不手写偏移。
 * 窗口可跨午夜——当 end <= start 时，窗口从前一天 start 延续到当天 end。
 *
 * 推迟上限（超过就不发了，记 skipped 由调度器落库）：
 *  - 窗口结束晚于原定时刻 12 小时；或
 *  - 已经越过该条目所属**日记日的下一个日界**（默认 04:00）——即拖进了"下一天"。
 */
import { addDays, diaryDate, isoDate, resolveLocal, wallClock, type ISODate } from '@daybook/shared';

export interface QuietHours {
  enabled: boolean;
  /** 'HH:MM' 本地时间 */
  start: string;
  /** 'HH:MM' 本地时间 */
  end: string;
}

export interface QuietHoursInput {
  /** 原定投递时刻 */
  deliverAt: Date;
  quiet: QuietHours;
  timezone: string;
  dayStartHour: number;
}

export interface QuietHoursDecision {
  action: 'deliver' | 'defer' | 'skip';
  /** defer 时给出新的投递时刻；skip 时给出本应推迟到的时刻（供日志） */
  at?: Date;
  reason?: string;
}

/** 推迟上限：晚于原定时刻 12 小时就不发了（避免"当天的提醒拖到快第二天"） */
const MAX_DEFER_MS = 12 * 60 * 60 * 1000;

function toMinutes(localTime: string): number {
  const [hour, minute] = localTime.split(':').map(Number);
  if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) {
    throw new RangeError(`不是合法的 HH:MM：${localTime}`);
  }
  return hour * 60 + minute;
}

export function applyQuietHours(input: QuietHoursInput): QuietHoursDecision {
  const { deliverAt, quiet, timezone, dayStartHour } = input;
  if (!quiet.enabled) return { action: 'deliver' };

  const startMin = toMinutes(quiet.start);
  const endMin = toMinutes(quiet.end);

  const wall = wallClock(deliverAt, timezone);
  const localDate: ISODate = isoDate(wall.year, wall.month, wall.day);
  const curMin = wall.hour * 60 + wall.minute;

  // 半开区间 [start, end)；跨午夜时分成 [start, 24:00) ∪ [0, end) 两段
  const crossesMidnight = endMin <= startMin;
  const inWindow = crossesMidnight
    ? curMin >= startMin || curMin < endMin
    : curMin >= startMin && curMin < endMin;
  if (!inWindow) return { action: 'deliver' };

  // 窗口结束落在哪一天：跨午夜且当前处于午夜前那一段 → 次日；否则当天
  const endDate = crossesMidnight && curMin >= startMin ? addDays(localDate, 1) : localDate;
  const at = resolveLocal(endDate, quiet.end, timezone);

  // 推迟太晚就不发了：超过 12 小时，或越过所属日记日的下一个日界
  const diaryDay = diaryDate(deliverAt, timezone, dayStartHour);
  const nextDayBoundary = resolveLocal(
    addDays(diaryDay, 1),
    `${String(dayStartHour).padStart(2, '0')}:00`,
    timezone,
  );
  if (at.getTime() - deliverAt.getTime() > MAX_DEFER_MS || at.getTime() >= nextDayBoundary.getTime()) {
    return { action: 'skip', at, reason: 'quiet_hours' };
  }

  return { action: 'defer', at };
}
