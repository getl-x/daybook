import { useCallback, useEffect, useState } from 'react';

import { AppShell } from '../components/AppShell.tsx';
import { DiaryForm, type DiaryFormState } from '../components/DiaryForm.tsx';
import { IncidentSection } from '../components/IncidentSection.tsx';
import { Banner, Chip, SaveStatusLine } from '../components/ui.tsx';
import { fetchHealth, fetchToday, type Session, type TodayView } from '../lib/api.ts';
import { detectPlatform } from '../lib/device.ts';
import { formatDiaryDate } from '../lib/format.ts';
import { hrefInstall } from '../lib/router.ts';

interface Props {
  session: Session;
  onLogout(): void;
}

/**
 * 今日页：早间记录（昨日回顾 + 今日计划）、突发事情、晚间总结。
 *
 * 关键：早间卡片涉及**两行记录**——"昨日回顾"写昨天那一行、"今日计划/晚间总结"写今天那一行，
 * 因此这里挂了两个 DiaryForm（各自带自己的 base_updated_at）。
 */
export function TodayPage({ session, onLogout }: Props) {
  const [view, setView] = useState<TodayView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState('检查服务中…');

  const reload = useCallback(async (): Promise<void> => {
    try {
      setView(await fetchToday());
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void reload();
    void fetchHealth()
      .then((health) => setStatus(health.db === 'ok' ? '服务正常' : `数据库异常（${health.db}）`))
      .catch(() => setStatus('连不上服务'));
  }, [reload]);

  return (
    <AppShell
      title={view ? formatDiaryDate(view.meta.diary_date) : 'daybook'}
      subtitle={`${session.user.username} · ${status}${view ? ` · ${view.meta.timezone}` : ''}`}
      onLogout={onLogout}
    >
      {loadError ? (
        <Banner tone="error">
          {loadError}
          <button type="button" onClick={() => void reload()} className="ml-3 underline">
            重试
          </button>
        </Banner>
      ) : null}

      <InstallHint />

      {view ? (
        <TodayContent key={view.meta.diary_date} session={session} view={view} reload={reload} />
      ) : (
        <p className="py-10 text-center text-sm text-slate-400">加载中…</p>
      )}
    </AppShell>
  );
}

interface ContentProps {
  session: Session;
  view: TodayView;
  reload(): Promise<void>;
}

function TodayContent({ session, view, reload }: ContentProps) {
  const [saveStates, setSaveStates] = useState<Record<string, DiaryFormState>>({});
  const report = (key: string) => (state: DiaryFormState) => setSaveStates((previous) => ({ ...previous, [key]: state }));

  const states = Object.values(saveStates).map((entry) => entry.state);
  const savedAt = Object.values(saveStates).reduce<number | null>(
    (latest, entry) => (entry.savedAt !== null && (latest === null || entry.savedAt > latest) ? entry.savedAt : latest),
    null,
  );
  const message = Object.values(saveStates).find((entry) => entry.message !== null)?.message ?? null;

  return (
    <>
      <section className="flex flex-wrap items-center gap-2 text-xs">
        <Chip done={view.progress.morningDone}>{view.progress.morningDone ? '早间已完成' : '早间待完成'}</Chip>
        <Chip done={view.progress.eveningDone}>{view.progress.eveningDone ? '晚间已完成' : '晚间待完成'}</Chip>
        <Chip done={view.incidents.length > 0}>{view.incidents.length} 条突发记录</Chip>
        <span className="ml-auto text-slate-400">
          <SaveStatusLine states={states} savedAt={savedAt} message={message} />
        </span>
      </section>

      <section className="space-y-5 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <header className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">早间记录</h2>
          <span className="text-xs text-slate-400">{view.meta.diary_date}</span>
        </header>

        <div className="space-y-4 border-t border-dashed border-slate-200 pt-4 dark:border-slate-700">
          <p className="text-xs font-medium tracking-wide text-slate-400 uppercase">
            昨日回顾 · {formatDiaryDate(view.meta.yesterday)}
          </p>
          <DiaryForm
            userId={session.user.id}
            entryDate={view.meta.yesterday}
            initialFields={view.yesterday.fields}
            fields={[
              { field: 'day_events', prompt: '昨天发生了什么？' },
              { field: 'day_meals', prompt: '昨天吃了什么？' },
            ]}
            onStateChange={report('review')}
            showStatus={false}
          />
        </div>

        <div className="space-y-4 border-t border-dashed border-slate-200 pt-4 dark:border-slate-700">
          <p className="text-xs font-medium tracking-wide text-slate-400 uppercase">
            今日计划 · {formatDiaryDate(view.meta.diary_date)}
          </p>
          <DiaryForm
            userId={session.user.id}
            entryDate={view.meta.diary_date}
            initialFields={view.today.fields}
            fields={[{ field: 'day_plan', prompt: '今天准备做什么？' }]}
            onStateChange={report('plan')}
            showStatus={false}
          />
        </div>
      </section>

      <IncidentSection
        date={view.meta.diary_date}
        incidents={view.incidents}
        onChanged={reload}
        emptyHint="今天还没有记录。想到什么就随手记一条。"
      />

      <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <header className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">晚间总结</h2>
          <span className="text-xs text-slate-400">{view.meta.diary_date}</span>
        </header>
        <DiaryForm
          userId={session.user.id}
          entryDate={view.meta.diary_date}
          initialFields={view.today.fields}
          fields={[{ field: 'evening_summary', prompt: '今天过得怎么样？' }]}
          onStateChange={report('summary')}
          showStatus={false}
        />
      </section>
    </>
  );
}

/**
 * 安装提示：iOS Safari 标签页里明确告诉用户"装到主屏才有提醒"（这是 iOS 的硬约束），
 * 其它平台给一个低调入口。引导内容在 #/install。
 */
function InstallHint() {
  const [platform] = useState(() => detectPlatform());
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('daybook.installHint.dismissed') === '1');

  if (dismissed) return null;

  if (platform === 'ios-safari') {
    return (
      <Banner tone="warn">
        <span>还没装到主屏幕——装好后才能收到每天的提醒。</span>
        <a href={hrefInstall()} className="ml-3 underline">
          看安装步骤
        </a>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem('daybook.installHint.dismissed', '1');
            setDismissed(true);
          }}
          className="ml-3 underline"
        >
          以后再说
        </button>
      </Banner>
    );
  }

  return (
    <p className="text-center text-xs text-slate-400">
      <a href={hrefInstall()} className="underline">
        安装到主屏 / 提醒设置
      </a>
    </p>
  );
}
