import { useState } from 'react';

import { formatDiaryDate, formatTime } from '../lib/format.ts';
import { createIncident, deleteIncident, updateIncident, type Incident } from '../lib/api.ts';
import { IncidentModal, fromLocalInputValue, type IncidentDraft } from './IncidentModal.tsx';
import { Banner, TagChip } from './ui.tsx';

interface Props {
  /** 这一块展示哪一天的突发记录（也是新建时的归属日参考） */
  date: string;
  incidents: Incident[];
  /** 增删改之后让父组件重新拉数据 */
  onChanged(): Promise<void>;
  title?: string;
  emptyHint?: string;
  /** 今日页用：记录按钮放大成全宽主按钮、正文也大一号，想到什么立刻就能记一条 */
  prominent?: boolean;
}

/** 突发事情：时间线 + 记录此刻 / 编辑弹层。今日页与单日详情页共用。 */
export function IncidentSection({
  date,
  incidents,
  onChanged,
  title = '此刻，值得记下',
  emptyHint,
  prominent = false,
}: Props) {
  const [modal, setModal] = useState<{ incident: Incident | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(draft: IncidentDraft): Promise<void> {
    const occurredAt = fromLocalInputValue(draft.occurredAtLocal);
    if (modal?.incident) {
      const { incident } = await updateIncident(modal.incident.id, {
        content: draft.content,
        occurredAt,
        tag: draft.tag,
      });
      setModal(null);
      setNotice(
        incident.entryDate === date
          ? '已更新'
          : `时间改到了别的日记日，这条记录已移动到 ${formatDiaryDate(incident.entryDate)}`,
      );
    } else {
      await createIncident({ id: crypto.randomUUID(), content: draft.content, occurredAt, tag: draft.tag });
      setModal(null);
      setNotice('已记录');
    }
    await onChanged();
  }

  async function remove(): Promise<void> {
    if (!modal?.incident) return;
    await deleteIncident(modal.incident.id);
    setModal(null);
    await onChanged();
  }

  function openNew(): void {
    setModal({ incident: null });
  }

  return (
    <section className="incident-card">
      <header className="flex items-center justify-between gap-3">
        <div>
          <p className="section-kicker">LITTLE MOMENTS</p>
          <h2>{title}</h2>
        </div>
        <button type="button" onClick={openNew} className="button-primary">
          ＋ 记录此刻
        </button>
      </header>

      {notice ? (
        <div className="mt-3">
          <Banner tone="info" onDismiss={() => setNotice(null)}>
            {notice}
          </Banner>
        </div>
      ) : null}

      {incidents.length === 0 ? (
        <div className="incident-empty">
          <span aria-hidden="true">✧</span>
          <p>{emptyHint ?? '还没有记录。想到什么就随手记一条。'}</p>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
          {incidents.map((incident) => (
            <li key={incident.id}>
              <button
                type="button"
                onClick={() => setModal({ incident })}
                className={
                  prominent
                    ? 'flex w-full items-start gap-3 rounded-lg px-1 py-3.5 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/60'
                    : 'flex w-full items-start gap-3 rounded-lg px-1 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/60'
                }
              >
                <span className="w-12 shrink-0 pt-0.5 text-xs tabular-nums text-slate-400">
                  {formatTime(incident.occurredAt)}
                </span>
                <span
                  className={
                    prominent
                      ? 'min-w-0 flex-1 text-base whitespace-pre-wrap text-slate-700 dark:text-slate-200'
                      : 'min-w-0 flex-1 text-sm whitespace-pre-wrap text-slate-700 dark:text-slate-200'
                  }
                >
                  {incident.content}
                </span>
                {incident.tag ? <TagChip tag={incident.tag} /> : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      {modal ? (
        <IncidentModal
          incident={modal.incident}
          onClose={() => setModal(null)}
          onSubmit={submit}
          {...(modal.incident ? { onDelete: remove } : {})}
        />
      ) : null}
    </section>
  );
}
