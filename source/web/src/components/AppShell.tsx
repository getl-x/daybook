import type { ReactNode } from 'react';

import { hrefCalendar, hrefSettings, hrefToday, monthOfLocalToday, useRoute } from '../lib/router.ts';

interface Props {
  title: string;
  subtitle: string;
  onLogout(): void;
  children: ReactNode;
}

/** 页面外壳：标题栏（含退出）+ 今日/日历/设置 导航 + 内容区。 */
export function AppShell({ title, subtitle, onLogout, children }: Props) {
  const route = useRoute();
  const calendarMonth = route.name === 'calendar' ? route.month : route.name === 'day' ? route.date.slice(0, 7) : monthOfLocalToday();
  const active = route.name === 'today' ? 'today' : route.name === 'settings' ? 'settings' : 'calendar';

  const tabs = [
    { key: 'today' as const, label: '今日', href: hrefToday() },
    { key: 'calendar' as const, label: '日历', href: hrefCalendar(calendarMonth) },
    { key: 'settings' as const, label: '设置', href: hrefSettings() },
  ];

  return (
    <div className="min-h-full bg-slate-50 pb-[calc(5rem+var(--safe-bottom))] dark:bg-slate-950">
      {/* 顶部让出状态栏高度（--safe-top 见 index.css）：原生壳里标题栏不再被状态栏压住，
          浏览器 / PWA 里这个值恒为 0，和改动前完全一致。 */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/85 px-4 pt-[calc(0.75rem+var(--safe-top))] backdrop-blur dark:border-slate-800 dark:bg-slate-900/85">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-50">{title}</p>
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            退出
          </button>
        </div>

        {/* 三栏按屏幕宽度等分：每栏 flex-1 + 文字居中，选中态的底线正好铺满整栏 */}
        <nav className="mx-auto mt-2 flex max-w-3xl">
          {tabs.map((tab) => (
            <a
              key={tab.key}
              href={tab.href}
              className={
                active === tab.key
                  ? '-mb-px flex-1 border-b-2 border-slate-900 px-2 py-2 text-center text-sm font-medium text-slate-900 dark:border-slate-100 dark:text-slate-50'
                  : '-mb-px flex-1 border-b-2 border-transparent px-2 py-2 text-center text-sm text-slate-500 transition hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
              }
            >
              {tab.label}
            </a>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">{children}</main>
    </div>
  );
}
