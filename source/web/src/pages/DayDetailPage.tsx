import { useCallback, useEffect, useState } from 'react';

import { AppShell } from '../components/AppShell.tsx';
import { DiaryForm } from '../components/DiaryForm.tsx';
import { IncidentSection } from '../components/IncidentSection.tsx';
import { Banner } from '../components/ui.tsx';
import { fetchDate, type DiaryEntry, type Incident, type Session } from '../lib/api.ts';
import { formatDiaryDate } from '../lib/format.ts';
import { hrefCalendar, monthOfLocalToday } from '../lib/router.ts';

interface Props {
  session: Session;
  date: string;
  onLogout(): void;
}

/**
 * 单日详情 / 补写：四个字段都能改（写进这一天自己的那一行），
 * 下面列出这一天的突发记录——与今日页共用同一套组件。
 */
export function DayDetailPage({ session, date, onLogout }: Props) {
  const [entry, setEntry] = useState<DiaryEntry | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const result = await fetchDate(date);
      setEntry(result.entry);
      setIncidents(result.incidents);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加载失败');
    }
  }, [date]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const month = date.slice(0, 7) || monthOfLocalToday();

  return (
    <AppShell title={formatDiaryDate(date)} subtitle={`${session.user.username} · 补写与编辑`} onLogout={onLogout}>
      <a
        href={hrefCalendar(month)}
        className="inline-flex items-center gap-1 text-xs text-slate-500 transition hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
      >
        ← 回到日历
      </a>

      {error ? <Banner tone="error">{error}</Banner> : null}

      {entry ? (
        <>
          <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            <header className="flex items-baseline justify-between">
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">这一天的记录</h2>
              <span className="text-xs text-slate-400">
                {entry.exists ? `第 ${entry.version} 次修改` : '还没有内容'}
              </span>
            </header>
            <p className="text-xs text-slate-400">
              这一天自己的四个字段都能改；「回顾」写的是这一天的回忆，不是今天写的。
            </p>
            <DiaryForm
              key={date}
              userId={session.user.id}
              entryDate={date}
              initialFields={entry.fields}
              fields={[
                { field: 'day_events', prompt: '这天发生了什么？' },
                { field: 'day_meals', prompt: '这天吃了什么？' },
                { field: 'day_plan', prompt: '这天原本打算做什么？' },
                { field: 'evening_summary', prompt: '这天过得怎么样？' },
              ]}
            />
          </section>

          <IncidentSection
            date={date}
            incidents={incidents}
            onChanged={reload}
            emptyHint="这一天没有突发记录。"
          />
        </>
      ) : (
        <p className="py-10 text-center text-sm text-slate-400">加载中…</p>
      )}
    </AppShell>
  );
}
