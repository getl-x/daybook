import { useEffect, useState } from 'react';

import { AppShell } from '../components/AppShell.tsx';
import { Banner } from '../components/ui.tsx';
import { fetchCalendar, type CalendarDay, type Session } from '../lib/api.ts';
import { daysInMonth, firstWeekdayOfMonth, formatMonthTitle, isoDate, shiftMonth } from '../lib/format.ts';
import { hrefDay, hrefCalendar } from '../lib/router.ts';

interface Props {
  session: Session;
  month: string;
  onLogout(): void;
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const;

/** 日历页：月视图，有记录的日期打点；点某天进单日详情（补写/编辑）。 */
export function CalendarPage({ session, month, onLogout }: Props) {
  const [days, setDays] = useState<CalendarDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDays(null);
    void fetchCalendar(month)
      .then((result) => {
        if (cancelled) return;
        setDays(result.days);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : '加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [month]);

  const byDate = new Map((days ?? []).map((day) => [day.date, day]));
  const total = daysInMonth(month);
  // 周一开头：JS 的 getUTCDay() 里周日是 0，换算成"前面空几格"
  const leading = (firstWeekdayOfMonth(month) + 6) % 7;
  const cells: (number | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: total }, (_, index) => index + 1),
  ];

  // 高亮"今天"：用浏览器本地日期即可（服务端日记日在今日页显示）
  const now = new Date();
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const recorded = byDate.size;

  return (
    <AppShell
      title={formatMonthTitle(month)}
      subtitle={`${session.user.username} · 这个月有记录 ${recorded} 天`}
      onLogout={onLogout}
    >
      {error ? <Banner tone="error">{error}</Banner> : null}

      <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <header className="mb-3 flex items-center justify-between">
          <a
            href={hrefCalendar(shiftMonth(month, -1))}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            ← 上个月
          </a>
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{formatMonthTitle(month)}</span>
          <a
            href={hrefCalendar(shiftMonth(month, 1))}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            下个月 →
          </a>
        </header>

        <div className="grid grid-cols-7 gap-1 text-center text-xs text-slate-400">
          {WEEKDAYS.map((label) => (
            <span key={label} className="py-1">
              {label}
            </span>
          ))}
        </div>

        <div className="mt-1 grid grid-cols-7 gap-1">
          {cells.map((day, index) => {
            if (day === null) return <span key={`blank-${index}`} />;
            const date = isoDate(month, day);
            const record = byDate.get(date);
            const isToday = date === localToday;
            const hasAny = record !== undefined;

            return (
              <a
                key={date}
                href={hrefDay(date)}
                className={[
                  'flex aspect-square flex-col items-center justify-center gap-1 rounded-lg text-sm transition',
                  hasAny
                    ? 'bg-slate-900 text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                  isToday ? 'ring-2 ring-emerald-500 ring-offset-1 dark:ring-offset-slate-900' : '',
                ].join(' ')}
              >
                <span className="tabular-nums">{day}</span>
                {hasAny ? (
                  <span className="flex items-center gap-1 text-[10px] leading-none opacity-80">
                    {record?.hasContent ? <span title="有文字记录">●</span> : null}
                    {record !== undefined && record.incidentCount > 0 ? <span title="有突发记录">◆{record.incidentCount}</span> : null}
                  </span>
                ) : (
                  <span className="text-[10px] leading-none opacity-0">·</span>
                )}
              </a>
            );
          })}
        </div>

        <p className="mt-3 text-center text-xs text-slate-400">● 有文字记录 · ◆ 有突发记录 · 点某天可以查看或补写</p>
      </section>
    </AppShell>
  );
}
