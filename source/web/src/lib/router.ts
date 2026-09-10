/**
 * 极简 hash 路由（不引第三方库）。
 *
 * 路由表：
 *   #/today              今日
 *   #/calendar/2026-09   日历（某月）
 *   #/day/2026-09-05     单日详情 / 补写
 *   #/install            安装与提醒引导
 *
 * 用 hash 而不是 history API：静态托管（由 Fastify 托管 dist）下刷新不会 404，
 * 也省掉服务端回退规则。
 */
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'today' }
  | { name: 'calendar'; month: string }
  | { name: 'day'; date: string }
  | { name: 'install' }
  | { name: 'settings' };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [head, param] = path.split('/');

  if (head === 'install') return { name: 'install' };
  if (head === 'settings') return { name: 'settings' };
  if (head === 'calendar' && param && MONTH_PATTERN.test(param)) return { name: 'calendar', month: param };
  if (head === 'day' && param && DATE_PATTERN.test(param)) return { name: 'day', date: param };
  return { name: 'today' };
}

export function hrefInstall(): string {
  return '#/install';
}

export function hrefSettings(): string {
  return '#/settings';
}

export function monthOfLocalToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function hrefCalendar(month: string): string {
  return `#/calendar/${month}`;
}

export function hrefDay(date: string): string {
  return `#/day/${date}`;
}

export function hrefToday(): string {
  return '#/today';
}

export function navigate(hash: string): void {
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}
