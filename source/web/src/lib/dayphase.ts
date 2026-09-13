/**
 * 「晚间总结」什么时候出现：跟着设置里的「晚间提醒」时间走，但不能早于 18:00。
 *
 * 纯函数（不碰 window / Date），方便在 node --test 里直接跑。
 */

/** 晚间总结最早出现的时间（当天分钟数） */
export const EVENING_EARLIEST_MINUTES = 18 * 60;

/** 'HH:MM' → 当天的分钟数；不是合法时间就返回 null */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * 晚间总结的出现阈值（当天分钟数）= max(设置里的晚间提醒时间, 18:00)。
 * 提醒时间没设或不合法时退回 18:00。
 */
export function eveningThresholdMinutes(eveningTime: string): number {
  const configured = parseClock(eveningTime);
  return configured === null ? EVENING_EARLIEST_MINUTES : Math.max(configured, EVENING_EARLIEST_MINUTES);
}

/** 现在（当天分钟数）到晚间总结的出现时间了吗 */
export function isEveningTime(nowMinutes: number, eveningTime: string): boolean {
  return nowMinutes >= eveningThresholdMinutes(eveningTime);
}

/** Date → 当天的本地分钟数 */
export function localMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}
