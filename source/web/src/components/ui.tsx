import type { ReactNode } from 'react';

import { INCIDENT_TAG_LABELS, type IncidentTag } from '../lib/api.ts';
import type { SaveState } from '../lib/autosave.ts';

export function Chip({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <span
      className={
        done
          ? 'rounded-full bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900'
          : 'rounded-full bg-slate-100 px-2.5 py-1 text-slate-500 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700'
      }
    >
      {children}
    </span>
  );
}

export function TagChip({ tag }: { tag: string }) {
  const label = INCIDENT_TAG_LABELS[tag as IncidentTag] ?? tag;
  return (
    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
      {label}
    </span>
  );
}

export function SaveStatusLine({
  states,
  savedAt,
  message,
}: {
  states: SaveState[];
  savedAt: number | null;
  message: string | null;
}) {
  if (states.includes('error')) return <span className="text-red-600">登录已过期，请重新登录</span>;
  if (states.includes('offline')) return <span className="text-amber-600">{message ?? '未同步，已存本机草稿'}</span>;
  if (states.includes('saving')) return <span>正在保存…</span>;
  if (states.includes('dirty')) return <span>有改动待保存…</span>;
  if (savedAt) {
    return <span>已保存 {new Date(savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>;
  }
  // 没有别的状态可显示时，优先显示 message（例如"本机有旧草稿，但服务器上的内容更新"）
  if (message) return <span className="text-slate-500">{message}</span>;
  return <span>自动保存已开启</span>;
}

/** 统一的提示条（冲突/通知/错误都用它，样式一致） */
export function Banner({
  tone,
  children,
  onDismiss,
}: {
  tone: 'info' | 'warn' | 'error';
  children: ReactNode;
  onDismiss?: () => void;
}) {
  const styles = {
    info: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
    warn: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-200 dark:ring-amber-900',
    error: 'bg-red-50 text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900',
  }[tone];

  return (
    <div className={`rounded-2xl p-3 text-sm ${styles}`}>
      {children}
      {onDismiss ? (
        <button type="button" onClick={onDismiss} className="ml-3 underline">
          知道了
        </button>
      ) : null}
    </div>
  );
}
