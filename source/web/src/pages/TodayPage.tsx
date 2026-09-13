import { useCallback, useEffect, useRef, useState } from 'react';

import { AppShell } from '../components/AppShell.tsx';
import { DiaryForm, type DiaryFormHandle, type DiaryFormState } from '../components/DiaryForm.tsx';
import { IncidentSection } from '../components/IncidentSection.tsx';
import { Banner, Chip, SaveStatusLine } from '../components/ui.tsx';
import { fetchHealth, fetchSettings, fetchToday, type Session, type TodayView } from '../lib/api.ts';
import { isEveningTime, localMinutes } from '../lib/dayphase.ts';
import { detectPlatform } from '../lib/device.ts';
import { formatDiaryDate } from '../lib/format.ts';
import { hrefInstall } from '../lib/router.ts';
import { isNativeShell } from '../lib/server.ts';

interface Props {
  session: Session;
  onLogout(): void;
}

/**
 * 今日页，从上到下三块：
 *   1. 突发事情——放在最前、按钮给足大小，想到什么立刻就能记一条；
 *   2. 早间记录——只有"今日计划"，点保存后收成一行摘要；
 *   3. 晚间总结——到了晚间提醒时间（最早 18:00）才出现，平时隐藏。
 */
export function TodayPage({ session, onLogout }: Props) {
  const [view, setView] = useState<TodayView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState('检查服务中…');
  /** 晚间总结的出现时间跟着设置里的「晚间提醒」走；取不到设置就按最早时间 18:00 */
  const [eveningTime, setEveningTime] = useState('18:00');

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
    // 设置拉不到不影响写日记：晚间总结退回默认的 18:00
    void fetchSettings()
      .then((settings) => setEveningTime(settings.reminders.evening_time))
      .catch(() => undefined);
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
        <TodayContent
          key={view.meta.diary_date}
          session={session}
          view={view}
          eveningTime={eveningTime}
          reload={reload}
        />
      ) : (
        <p className="py-10 text-center text-sm text-slate-400">加载中…</p>
      )}
    </AppShell>
  );
}

interface ContentProps {
  session: Session;
  view: TodayView;
  /** 设置里的「晚间提醒」时间（'HH:MM'）：晚间总结到这个点之后才出现 */
  eveningTime: string;
  reload(): Promise<void>;
}

function TodayContent({ session, view, eveningTime, reload }: ContentProps) {
  const [planState, setPlanState] = useState<DiaryFormState | null>(null);
  const [summaryState, setSummaryState] = useState<DiaryFormState | null>(null);
  const planRef = useRef<DiaryFormHandle>(null);

  /**
   * 早间记录折叠状态：今日计划已经有内容就直接收成一行摘要（初始值只在挂载时算一次，
   * 免得自动保存刚把内容写进去就把表单收走）。
   */
  const [planOpen, setPlanOpen] = useState(() => !view.progress.morningDone);
  /** 还没到点但用户主动要写晚间总结 */
  const [eveningRevealed, setEveningRevealed] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // 页面可能一直开着（App 常驻后台）：每分钟对一次表，跨过晚间时间点后总结自己出现
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const forms = [planState, summaryState];
  const states = forms.flatMap((entry) => (entry ? [entry.state] : []));
  const savedAt = forms.reduce<number | null>(
    (latest, entry) => (entry?.savedAt != null && (latest === null || entry.savedAt > latest) ? entry.savedAt : latest),
    null,
  );
  const message = forms.find((entry) => entry?.message != null)?.message ?? null;

  /** 摘要行显示本地内容（还没同步上去的草稿也要显示出来） */
  const planText = planState?.values.day_plan ?? view.today.fields.day_plan?.value ?? '';
  const eveningVisible =
    eveningRevealed || view.progress.eveningDone || isEveningTime(localMinutes(now), eveningTime);

  /** 保存 = 立即落库 + 收起表单；表单只是被隐藏（没卸载），没传完的改动继续走自动保存 */
  function savePlan(): void {
    void planRef.current?.flush();
    setPlanOpen(false);
  }

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

      <IncidentSection
        prominent
        date={view.meta.diary_date}
        incidents={view.incidents}
        onChanged={reload}
        emptyHint="今天还没有记录。想到什么就随手记一条。"
      />

      <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <header className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">早间记录</h2>
          <span className="text-xs text-slate-400">{view.meta.diary_date}</span>
        </header>

        {/* 只隐藏不卸载：useAutosave 的定时器 / 草稿 / 冲突提示照常工作，顶部状态行也不会卡在"正在保存" */}
        <div className={planOpen ? 'space-y-4 border-t border-dashed border-slate-200 pt-4 dark:border-slate-700' : 'hidden'}>
          <DiaryForm
            ref={planRef}
            userId={session.user.id}
            entryDate={view.meta.diary_date}
            initialFields={view.today.fields}
            fields={[{ field: 'day_plan', prompt: '今日计划' }]}
            onStateChange={setPlanState}
            showStatus={false}
          />
          <button
            type="button"
            onClick={savePlan}
            className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            保存
          </button>
        </div>

        {planOpen ? null : (
          <div className="flex items-start justify-between gap-3 border-t border-dashed border-slate-200 pt-4 dark:border-slate-700">
            <p className="min-w-0 flex-1 line-clamp-2 text-sm whitespace-pre-wrap text-slate-600 dark:text-slate-300">
              {planText.trim() === '' ? '今天还没有计划。' : planText}
            </p>
            <button
              type="button"
              onClick={() => setPlanOpen(true)}
              className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              展开 / 修改
            </button>
          </div>
        )}
      </section>

      {eveningVisible ? (
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
            onStateChange={setSummaryState}
            showStatus={false}
          />
        </section>
      ) : (
        <p className="text-center text-xs text-slate-400">
          <button type="button" onClick={() => setEveningRevealed(true)} className="underline">
            现在就写晚间总结
          </button>
        </p>
      )}
    </>
  );
}

/**
 * 安装提示：原生壳里已经是装好的 App 了，不要再提示"安装到主屏"；
 * iOS Safari 标签页里明确告诉用户"装到主屏才有提醒"（这是 iOS 的硬约束），
 * 其它平台给一个低调入口。引导内容在 #/install。
 */
function InstallHint() {
  const [native] = useState(() => isNativeShell());
  const [platform] = useState(() => detectPlatform());
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('daybook.installHint.dismissed') === '1');

  if (native) return null;
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
