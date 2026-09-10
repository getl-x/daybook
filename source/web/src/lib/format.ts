/**
 * 日期/时间显示格式（统一放一处，避免各页面各写一套）。
 * 全部按 UTC 渲染"日记日"字符串，否则浏览器时区会把它挪一天。
 */
export function formatDiaryDate(date: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

export function formatShortDate(date: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

export function formatMonthTitle(month: string): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

/** '2026-09' → { year: 2026, monthNumber: 9 }（解构默认值让类型在 noUncheckedIndexedAccess 下也成立） */
function parseMonth(month: string): { year: number; monthNumber: number } {
  const [year = 1970, monthNumber = 1] = month.split('-').map(Number);
  return { year, monthNumber };
}

/** 月份加减：'2026-01' 减 1 → '2025-12' */
export function shiftMonth(month: string, delta: number): string {
  const { year, monthNumber } = parseMonth(month);
  const base = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 某月有多少天（用于日历格子） */
export function daysInMonth(month: string): number {
  const { year, monthNumber } = parseMonth(month);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

/** 某月 1 号是星期几（0=周日），日历里按周一开头排格子 */
export function firstWeekdayOfMonth(month: string): number {
  const { year, monthNumber } = parseMonth(month);
  return new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
}

export function isoDate(month: string, day: number): string {
  return `${month}-${String(day).padStart(2, '0')}`;
}
