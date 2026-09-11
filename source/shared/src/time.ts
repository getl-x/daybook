/**
 * daybook · 时间与"日记日"计算（前后端共用，零依赖）
 *
 * 规则见 DAYBOOK-DESIGN.zh-CN.md §5。三条铁律：
 *  1. "日记日"从本地时间 dayStartHour（默认 04:00）起算，04:00 之前的写入归属前一天；
 *  2. 时区一律用 IANA 名称（如 Asia/Shanghai），不使用固定偏移；
 *  3. DST 安全——目标墙上时间不存在（春季跳变）时顺延一个跳变间隔；
 *     存在两次（秋季回拨）时取较早的那一次。
 *
 * 只依赖 Intl（Node 与浏览器都内置完整 ICU），因此可以同时跑在
 * 服务端、浏览器与测试里：不需要任何第三方日期库。
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
/** 判断某个墙上时间是否存在/是否歧义时，向前后各探 12 小时的偏移。 */
const DST_PROBE_MS = 12 * 60 * MS_PER_MINUTE;

/** 'YYYY-MM-DD' 形式的本地日期。 */
export type ISODate = string;
/** 'HH:MM' 形式的本地时刻。 */
export type LocalTime = string;

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

export function isoDate(year: number, month: number, day: number): ISODate {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function parseISODate(date: ISODate): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`不是合法的 ISODate：${date}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** 纯日历加减（UTC 里算，不受 DST 影响）。 */
export function addDays(date: ISODate, days: number): ISODate {
  const { year, month, day } = parseISODate(date);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY);
  return isoDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function parseLocalTime(localTime: LocalTime): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (!match) throw new RangeError(`不是合法的 LocalTime：${localTime}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new RangeError(`越界的 LocalTime：${localTime}`);
  return { hour, minute };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function assertValidTimeZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`不是合法的 IANA 时区：${timeZone}`);
  }
}

function assertDayStartHour(dayStartHour: number): void {
  if (!Number.isInteger(dayStartHour) || dayStartHour < 0 || dayStartHour > 6) {
    throw new RangeError(`dayStartHour 必须是 0–6 的整数，收到 ${String(dayStartHour)}`);
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    assertValidTimeZone(timeZone);
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** 某个 UTC 瞬间在指定时区里的"墙上时间"。 */
export function wallClock(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const raw = parts.find((part) => part.type === type)?.value;
    if (raw === undefined) throw new Error(`时区 ${timeZone} 缺少 ${type} 字段`);
    return Number(raw);
  };
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    // 某些 ICU 版本在 hour12:false 下把午夜输出成 24
    hour: pick('hour') % 24,
    minute: pick('minute'),
    second: pick('second'),
  };
}

/** 该时区在某个瞬间相对 UTC 的偏移（分钟，东八区为 +480）。 */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  const wallAsUTC = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const instantTruncatedToSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((wallAsUTC - instantTruncatedToSecond) / MS_PER_MINUTE);
}

/**
 * 日记日：本地时间 dayStartHour 之前算前一天。
 *
 * 例（Asia/Shanghai，dayStartHour=4）：
 *   本地 2026-09-10 03:59 → 2026-09-09
 *   本地 2026-09-10 04:00 → 2026-09-10
 */
export function diaryDate(instant: Date, timeZone: string, dayStartHour = 4): ISODate {
  assertDayStartHour(dayStartHour);
  const wall = wallClock(instant, timeZone);
  const calendarDate = isoDate(wall.year, wall.month, wall.day);
  return wall.hour < dayStartHour ? addDays(calendarDate, -1) : calendarDate;
}

/**
 * 把"某时区的墙上时间"解析成 UTC 瞬间，DST 安全：
 *  - 正常：唯一解；
 *  - 秋季回拨（该墙上时间出现两次）：取较早的一次；
 *  - 春季跳变（该墙上时间不存在）：用跳变前的偏移解释，等价于把目标顺延一个跳变间隔
 *    （America/New_York 的 02:30 不存在 → 结果落在 03:30 EDT）。
 */
export function resolveWallTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naiveUTC = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offsetBefore = zoneOffsetMinutes(new Date(naiveUTC - DST_PROBE_MS), timeZone);
  const offsetAfter = zoneOffsetMinutes(new Date(naiveUTC + DST_PROBE_MS), timeZone);

  if (offsetBefore === offsetAfter) {
    return new Date(naiveUTC - offsetBefore * MS_PER_MINUTE);
  }

  const candidates = [
    new Date(naiveUTC - offsetBefore * MS_PER_MINUTE),
    new Date(naiveUTC - offsetAfter * MS_PER_MINUTE),
  ];
  const matches = (instant: Date): boolean => {
    const wall = wallClock(instant, timeZone);
    return (
      wall.year === year && wall.month === month && wall.day === day && wall.hour === hour && wall.minute === minute
    );
  };

  const valid = candidates.filter(matches);
  if (valid.length > 0) {
    // 回拨时两个候选都合法 → 取较早的那次，且当天只发一次（幂等键按日记日去重）
    return new Date(Math.min(...valid.map((candidate) => candidate.getTime())));
  }
  // 跳变：目标墙上时间不存在，candidates[0] 即"顺延一个跳变间隔"之后的结果
  // （candidates 恒有两个元素；`!` 只是满足 noUncheckedIndexedAccess，运行时无影响）
  return candidates[0]!;
}

/** 同上，入参为 ISODate + 'HH:MM'。 */
export function resolveLocal(date: ISODate, localTime: LocalTime, timeZone: string): Date {
  const { year, month, day } = parseISODate(date);
  const { hour, minute } = parseLocalTime(localTime);
  return resolveWallTime(year, month, day, hour, minute, timeZone);
}

/**
 * 下一次提醒触发时刻（严格大于 now）。
 *
 * 以"当前日记日"为起点逐日推进，因此：
 *  - 凌晨 03:00（仍属前一天日记日）查 09:00 提醒，得到的是当天自然日的 09:00；
 *  - now 恰好等于触发时刻时顺延到次日，避免重复触发。
 */
export function nextFireAt(now: Date, timeZone: string, localTime: LocalTime, dayStartHour = 4): Date {
  parseLocalTime(localTime);
  let date = diaryDate(now, timeZone, dayStartHour);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = resolveLocal(date, localTime, timeZone);
    if (candidate.getTime() > now.getTime()) return candidate;
    date = addDays(date, 1);
  }
  throw new Error('无法计算下一次提醒时刻（超出 4 天仍未找到候选，请检查入参）');
}
