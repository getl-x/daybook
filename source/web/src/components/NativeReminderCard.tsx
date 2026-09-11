/**
 * 「本地提醒」卡片：**只在 Capacitor 原生壳里渲染**（浏览器里 `isNativeShell()` 为 false → 返回 null，
 * 不影响 PWA 的任何行为）。
 *
 * 展示权限状态、已登记条数与下次提醒时间，并提供「启用 / 重新登记」按钮。
 * 提醒由 App 自己在本机排（非精确闹钟、不用 Google 服务），因此这里会把
 * 系统省电策略、重启需打开一次应用等注意事项写清楚。
 */
import { useState } from 'react';

import { type SettingsView } from '../lib/api.ts';
import {
  ensureNativePermission,
  getNativeReminderState,
  syncNativeSchedules,
  type NativePermission,
  type NativeReminderState,
} from '../lib/notifications/native.ts';
import { toReminderSettings } from '../lib/notifications/plan.ts';
import { isNativeShell } from '../lib/server.ts';
import { Banner } from './ui.tsx';

const PERMISSION_LABELS: Record<string, string> = {
  granted: '已允许',
  denied: '已被拒绝（去系统设置里允许）',
  prompt: '未启用',
  unsupported: '当前环境不支持',
  unknown: '未启用',
};

function formatNextAt(iso: string | null): string {
  if (!iso) return '未登记';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未登记';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function NativeReminderCard({ settings }: { settings: SettingsView }) {
  const native = isNativeShell();
  const [state, setState] = useState<NativeReminderState>(() => getNativeReminderState());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!native) return null;

  async function enable(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const permission: NativePermission = await ensureNativePermission();
      if (permission !== 'granted') {
        setError(
          permission === 'unsupported'
            ? '当前环境拿不到通知权限（不是原生壳？）'
            : '没有拿到通知权限，请在系统设置里允许后再试',
        );
        setState(getNativeReminderState());
        return;
      }
      const result = await syncNativeSchedules(toReminderSettings(settings));
      setState(getNativeReminderState());
      setNotice(result.scheduled > 0 ? `已登记 ${result.scheduled} 条本地提醒` : '已登记（无可排的提醒，检查是否开启早/晚提醒）');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '登记失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">本地提醒（APK）</h2>

      {error ? (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      ) : null}
      {notice ? (
        <Banner tone="info" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      ) : null}

      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500 dark:text-slate-400">通知权限</dt>
          <dd className="font-medium text-slate-800 dark:text-slate-100">
            {PERMISSION_LABELS[state.permission] ?? state.permission}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500 dark:text-slate-400">已登记</dt>
          <dd className="font-medium text-slate-800 dark:text-slate-100">{state.scheduled} 条</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500 dark:text-slate-400">下次提醒</dt>
          <dd className="font-medium text-slate-800 dark:text-slate-100">{formatNextAt(state.nextAt)}</dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={() => void enable()}
        disabled={busy}
        className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
      >
        {busy ? '登记中…' : '启用 / 重新登记本地提醒'}
      </button>

      <ul className="space-y-1 text-xs text-slate-400">
        <li>· 使用非精确本地提醒，不需要 Google 服务；系统省电策略可能稍微推迟。</li>
        <li>· 重启手机后需打开一次应用才会重新登记。</li>
        <li>· 若提醒不准，请在系统设置里对 daybook 关闭电池优化。</li>
      </ul>
    </section>
  );
}
