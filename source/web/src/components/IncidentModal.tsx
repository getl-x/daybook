import { useState, type FormEvent } from 'react';

import { INCIDENT_TAGS, INCIDENT_TAG_LABELS, type Incident, type IncidentTag } from '../lib/api.ts';

export interface IncidentDraft {
  content: string;
  /** datetime-local 的值（`YYYY-MM-DDTHH:mm`） */
  occurredAtLocal: string;
  tag: IncidentTag | null;
}

interface Props {
  /** 编辑已有记录时传入；新建时为空 */
  incident?: Incident | null;
  onClose(): void;
  onSubmit(draft: IncidentDraft): Promise<void>;
  onDelete?: () => Promise<void>;
}

/** 把 ISO 时间转成 `<input type="datetime-local">` 需要的本地时间字符串 */
export function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 本地时间字符串 → ISO（浏览器按本地时区解析 datetime-local） */
export function fromLocalInputValue(value: string): string {
  return new Date(value).toISOString();
}

export function IncidentModal({ incident = null, onClose, onSubmit, onDelete }: Props) {
  const [content, setContent] = useState(incident?.content ?? '');
  const [occurredAtLocal, setOccurredAtLocal] = useState(toLocalInputValue(incident?.occurredAt ?? new Date().toISOString()));
  const [tag, setTag] = useState<IncidentTag | null>((incident?.tag as IncidentTag | null) ?? 'other');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = content.trim();
    if (trimmed === '') {
      setError('内容不能为空');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit({ content: trimmed, occurredAtLocal, tag });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败');
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-lg space-y-4 rounded-t-2xl bg-white p-5 shadow-xl ring-1 ring-slate-200 sm:rounded-2xl dark:bg-slate-900 dark:ring-slate-800"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-50">
            {incident ? '编辑这条记录' : '记录此刻'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-slate-500 transition hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            取消
          </button>
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">内容</span>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={4}
            autoFocus
            placeholder="刚刚发生了什么？"
            className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none focus:border-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-300"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">时间</span>
            <input
              type="datetime-local"
              value={occurredAtLocal}
              onChange={(event) => setOccurredAtLocal(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none focus:border-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-300"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">标签</span>
            <select
              value={tag ?? ''}
              onChange={(event) => setTag((event.target.value || null) as IncidentTag | null)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none focus:border-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-300"
            >
              <option value="">不分类</option>
              {INCIDENT_TAGS.map((value) => (
                <option key={value} value={value}>
                  {INCIDENT_TAG_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3 pt-1">
          {onDelete ? (
            <button
              type="button"
              disabled={pending}
              onClick={async () => {
                if (!window.confirm('删除这条记录？')) return;
                setPending(true);
                try {
                  await onDelete();
                } catch {
                  setError('删除失败，请稍后再试');
                  setPending(false);
                }
              }}
              className="rounded-lg px-3 py-2 text-sm text-red-600 transition hover:bg-red-50 disabled:opacity-60 dark:hover:bg-red-950/40"
            >
              删除
            </button>
          ) : (
            <span />
          )}

          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            {pending ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
