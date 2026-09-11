import { useCallback, useEffect, useState } from 'react';

import { AppShell } from '../components/AppShell.tsx';
import { NativeReminderCard } from '../components/NativeReminderCard.tsx';
import { Banner } from '../components/ui.tsx';
import {
  ApiError,
  clearSession,
  deleteAccount,
  deleteSubscription,
  fetchNotificationStatus,
  fetchSettings,
  fetchTimezones,
  patchSettings,
  patchSubscription,
  type NotificationStatus,
  type Session,
  type SettingsView,
  type SubscriptionDevice,
} from '../lib/api.ts';
import { syncNativeSchedules } from '../lib/notifications/native.ts';
import { toReminderSettings } from '../lib/notifications/plan.ts';
import { isNativeShell, isValidServerBase, normalizeServerBase, saveServerBase, serverBase } from '../lib/server.ts';
import { NOTIFICATION_STATE_LABELS, notificationState, type NotificationState } from '../lib/device.ts';
import { subscribeToPush, unsubscribeFromPush } from '../lib/push.ts';

interface Props {
  session: Session;
  onLogout(): void;
}

/** 平台 → 中文小标签（手机 / 电脑 / 其他） */
const PLATFORM_LABELS: Record<string, string> = { 'ios-pwa': '手机', android: '手机', web: '电脑' };
function platformLabel(platform: string | null): string {
  return (platform ? PLATFORM_LABELS[platform] : undefined) ?? '其他';
}

/** 设置页：提醒时间与开关、时区/日界、通知权限与推送订阅。 */
export function SettingsPage({ session, onLogout }: Props) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [timezones, setTimezones] = useState<string[]>([]);
  const [permission, setPermission] = useState<NotificationState>(() => notificationState());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletePassword, setDeletePassword] = useState('');
  const native = isNativeShell();
  const [serverDraft, setServerDraft] = useState(() => serverBase());
  const [serverError, setServerError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [next, currentStatus] = await Promise.all([fetchSettings(), fetchNotificationStatus()]);
      setSettings(next);
      setStatus(currentStatus);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void reload();
    void fetchTimezones()
      .then(setTimezones)
      .catch(() => setTimezones([]));
  }, [reload]);

  async function save(payload: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next = await patchSettings(payload);
      setSettings(next);
      setNotice('已保存');
      // 原生壳里改完提醒设置立刻按新设置重排本地通知（浏览器里 native 为 false，不执行）。
      if (native) void syncNativeSchedules(toReminderSettings(next));
      void reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function enablePush(): Promise<void> {
    if (!settings?.push.vapid_public_key) {
      setError('服务端还没配置 VAPID 密钥（.env 里补 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 后重启）');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await subscribeToPush(settings.push.vapid_public_key);
    setPermission(notificationState());
    if (result.ok) {
      setNotice('已开启每日提醒');
      await reload();
    } else {
      setError(result.message);
    }
    setBusy(false);
  }

  async function removeSubscription(id: string): Promise<void> {
    setBusy(true);
    try {
      await unsubscribeFromPush(id);
      setNotice('这台设备的提醒已关闭');
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '取消失败');
    } finally {
      setBusy(false);
    }
  }

  /** 单独启用/停用某台设备：先乐观更新 UI，失败则回滚并提示，成功以服务端返回为准。 */
  async function toggleDevice(subscription: SubscriptionDevice, enabled: boolean): Promise<void> {
    setError(null);
    setTogglingId(subscription.id);
    const applyEnabled = (id: string, value: boolean): void => {
      setStatus((current) =>
        current
          ? {
              ...current,
              subscriptions: current.subscriptions.map((item) =>
                item.id === id ? { ...item, enabled: value } : item,
              ),
            }
          : current,
      );
    };

    applyEnabled(subscription.id, enabled); // 乐观更新
    try {
      const updated = await patchSubscription(subscription.id, enabled);
      setStatus((current) =>
        current
          ? {
              ...current,
              subscriptions: current.subscriptions.map((item) => (item.id === updated.id ? updated : item)),
            }
          : current,
      );
    } catch (caught) {
      applyEnabled(subscription.id, subscription.enabled); // 回滚
      setError(caught instanceof Error ? caught.message : '切换失败');
    } finally {
      setTogglingId(null);
    }
  }

  /** 切换服务器：保存后清掉本地会话并回到登录页（旧会话已不属于新服务器）。 */
  function saveServer(): void {
    setServerError(null);
    const trimmed = serverDraft.trim();
    if (trimmed === '' || !isValidServerBase(trimmed)) {
      setServerError('要填以 https:// 开头的完整地址');
      return;
    }
    const next = normalizeServerBase(trimmed);
    if (next === serverBase()) {
      setNotice('服务器地址没有变化');
      return;
    }
    saveServerBase(next);
    clearSession();
    window.alert('已切换服务器，请重新登录');
    onLogout();
  }

  const reminders = settings?.reminders;

  return (
    <AppShell title="设置" subtitle={`${session.user.username} · 提醒与通知`} onLogout={onLogout}>
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

      {!settings || !reminders ? (
        <p className="py-10 text-center text-sm text-slate-400">加载中…</p>
      ) : (
        <>
          <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">每日提醒</h2>

            <label className="flex items-center justify-between gap-4">
              <span className="text-sm text-slate-600 dark:text-slate-300">早上提醒</span>
              <span className="flex items-center gap-3">
                <input
                  type="time"
                  value={reminders.morning_time}
                  disabled={busy}
                  onChange={(event) => void save({ reminder_morning_time: event.target.value })}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
                <input
                  type="checkbox"
                  checked={reminders.morning_enabled}
                  disabled={busy}
                  onChange={(event) => void save({ reminder_morning_enabled: event.target.checked })}
                  className="h-4 w-4"
                />
              </span>
            </label>

            <label className="flex items-center justify-between gap-4">
              <span className="text-sm text-slate-600 dark:text-slate-300">晚上提醒</span>
              <span className="flex items-center gap-3">
                <input
                  type="time"
                  value={reminders.evening_time}
                  disabled={busy}
                  onChange={(event) => void save({ reminder_evening_time: event.target.value })}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
                <input
                  type="checkbox"
                  checked={reminders.evening_enabled}
                  disabled={busy}
                  onChange={(event) => void save({ reminder_evening_enabled: event.target.checked })}
                  className="h-4 w-4"
                />
              </span>
            </label>

            <label className="flex items-center justify-between gap-4">
              <span className="text-sm text-slate-600 dark:text-slate-300">
                写完就不提醒
                <span className="ml-2 text-xs text-slate-400">（当天内容已完成时跳过）</span>
              </span>
              <input
                type="checkbox"
                checked={reminders.only_if_incomplete}
                disabled={busy}
                onChange={(event) => void save({ reminder_only_if_incomplete: event.target.checked })}
                className="h-4 w-4"
              />
            </label>

            <label className="flex items-center justify-between gap-4">
              <span className="text-sm text-slate-600 dark:text-slate-300">
                静默时段
                <span className="ml-2 text-xs text-slate-400">（这段时间内不打扰）</span>
              </span>
              <input
                type="checkbox"
                checked={settings.quiet_hours.enabled}
                disabled={busy}
                onChange={(event) =>
                  void save({
                    quiet_enabled: event.target.checked,
                    // 开启时两端必须都有：没设过就给默认 22:00–07:00
                    quiet_start: settings.quiet_hours.start || '22:00',
                    quiet_end: settings.quiet_hours.end || '07:00',
                  })
                }
                className="h-4 w-4"
              />
            </label>

            {settings.quiet_hours.enabled ? (
              <label className="flex items-center justify-between gap-4">
                <span className="text-sm text-slate-600 dark:text-slate-300">静默起止</span>
                <span className="flex items-center gap-2">
                  <input
                    type="time"
                    value={settings.quiet_hours.start || '22:00'}
                    disabled={busy}
                    onChange={(event) => void save({ quiet_start: event.target.value })}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  />
                  <span className="text-slate-400">–</span>
                  <input
                    type="time"
                    value={settings.quiet_hours.end || '07:00'}
                    disabled={busy}
                    onChange={(event) => void save({ quiet_end: event.target.value })}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  />
                </span>
              </label>
            ) : null}

            <p className="text-xs text-slate-400">
              提醒按你的时区在设定时间发出，但<strong className="font-medium">不保证正好整点</strong>
              ：推送要经过系统通知服务，可能被延迟或在省电模式下晚一些。
            </p>
            <p className="text-xs text-slate-400">
              落在静默时段内的提醒会推迟到静默结束；推迟太晚（超过 12 小时或跨过下一个日界）则当天不发。
            </p>
          </section>

          <NativeReminderCard settings={settings} />

          <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">这台设备的通知</h2>

            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500 dark:text-slate-400">通知权限</dt>
                <dd className="font-medium text-slate-800 dark:text-slate-100">{NOTIFICATION_STATE_LABELS[permission]}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500 dark:text-slate-400">已订阅设备</dt>
                <dd className="font-medium text-slate-800 dark:text-slate-100">{status?.subscriptions.length ?? 0}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500 dark:text-slate-400">服务端推送</dt>
                <dd className="font-medium text-slate-800 dark:text-slate-100">
                  {status?.push_configured ? '已配置' : '未配置（缺 VAPID 密钥）'}
                </dd>
              </div>
            </dl>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void enablePush()}
                disabled={busy || !status?.push_configured}
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
              >
                开启每日提醒
              </button>
              <button
                type="button"
                onClick={() => setPermission(notificationState())}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                重新检查权限
              </button>
            </div>

            {permission === 'denied' ? (
              <Banner tone="warn">
                系统里已经拒绝过通知：iOS「设置 → 通知 → daybook → 允许通知」，安卓「设置 → 应用 → daybook → 通知」。
              </Banner>
            ) : null}

            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">设备列表</p>
              {status && status.subscriptions.length === 0 ? (
                <p className="text-xs text-slate-400">
                  还没有设备订阅提醒；在这台设备的浏览器里点上面的「开启每日提醒」按钮。
                </p>
              ) : null}
              {status && status.subscriptions.length > 0 ? (
                <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                  {status.subscriptions.map((subscription) => (
                    <li key={subscription.id} className="flex items-center justify-between gap-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span
                            className={`truncate ${
                              subscription.enabled
                                ? 'text-slate-700 dark:text-slate-200'
                                : 'text-slate-400 line-through dark:text-slate-500'
                            }`}
                          >
                            {subscription.label || '未命名设备'}
                          </span>
                          <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                            {platformLabel(subscription.platform)}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-xs text-slate-400">
                          {subscription.created_at.slice(0, 10)}
                          {subscription.failure_count > 0 ? ` · 失败 ${subscription.failure_count} 次` : ''}
                          {subscription.enabled ? '' : ' · 已停用'}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                          <input
                            type="checkbox"
                            checked={subscription.enabled}
                            disabled={busy || togglingId === subscription.id}
                            onChange={(event) => void toggleDevice(subscription, event.target.checked)}
                            className="h-4 w-4"
                          />
                          {subscription.enabled ? '启用' : '停用'}
                        </label>
                        <button
                          type="button"
                          onClick={() => void removeSubscription(subscription.id)}
                          disabled={busy}
                          className="text-xs text-red-600 underline disabled:opacity-50 dark:text-red-400"
                        >
                          删除
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            {status && status.recent_deliveries.length > 0 ? (
              <div className="space-y-1 text-xs text-slate-400">
                <p className="font-medium">最近几次提醒</p>
                {status.recent_deliveries.slice(0, 5).map((delivery) => (
                  <p key={`${delivery.local_date}-${delivery.kind}`}>
                    {delivery.local_date} · {delivery.kind === 'morning' ? '早间' : '晚间'} ·{' '}
                    {delivery.status === 'sent'
                      ? '已发送'
                      : delivery.status === 'skipped'
                        ? '已完成，跳过'
                        : delivery.status === 'failed'
                          ? `失败（${delivery.attempts} 次${delivery.last_error ? `：${delivery.last_error}` : ''}）`
                          : '排队中'}
                  </p>
                ))}
              </div>
            ) : null}
          </section>

          <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">时区与日记日</h2>
            <label className="block space-y-2">
              <span className="text-sm text-slate-600 dark:text-slate-300">时区</span>
              <select
                value={settings.timezone}
                disabled={busy}
                onChange={(event) => void save({ timezone: event.target.value })}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              >
                {!timezones.includes(settings.timezone) ? <option value={settings.timezone}>{settings.timezone}</option> : null}
                {timezones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-2">
              <span className="text-sm text-slate-600 dark:text-slate-300">
                日记日从几点开始
                <span className="ml-2 text-xs text-slate-400">（默认 04:00：凌晨写的算前一天）</span>
              </span>
              <select
                value={String(settings.day_start_hour)}
                disabled={busy}
                onChange={(event) => void save({ day_start_hour: Number(event.target.value) })}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              >
                {[0, 1, 2, 3, 4, 5, 6].map((hour) => (
                  <option key={hour} value={hour}>
                    {String(hour).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
            </label>

            <p className="text-xs text-slate-400">
              改时区或日界会立刻重算提醒排程；已经写下的日记日期不会被追溯修改。
            </p>
          </section>

          <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">服务器地址</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500 dark:text-slate-400">当前生效</dt>
                <dd className="text-right font-medium text-slate-800 dark:text-slate-100">
                  {serverBase() || '与网页同源（默认）'}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-slate-400">
              构建时可用
              <code className="mx-1 rounded bg-slate-100 px-1 py-0.5 text-[11px] dark:bg-slate-800">DAYBOOK_SERVER_URL</code>
              预设默认值。
            </p>

            {native ? (
              <div className="space-y-2">
                <label className="block space-y-2">
                  <span className="text-sm text-slate-600 dark:text-slate-300">修改服务器地址</span>
                  <input
                    type="url"
                    autoComplete="off"
                    value={serverDraft}
                    onChange={(event) => setServerDraft(event.target.value)}
                    placeholder="https://diary.example.com"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  />
                </label>
                <p className="text-xs text-slate-400">
                  自建服务器的完整地址（必须 https://）。保存后会退出登录，请重新登录。
                </p>
                {serverError ? <p className="text-xs text-red-600 dark:text-red-400">{serverError}</p> : null}
                <button
                  type="button"
                  onClick={() => saveServer()}
                  className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
                >
                  保存并重新登录
                </button>
              </div>
            ) : null}
          </section>

          <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-rose-200 dark:bg-slate-900 dark:ring-rose-900/60">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">删除账号</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              申请后立刻停用并退出登录，7 天内数据仍在（可联系管理员恢复）；到期后日记、突发事情、
              设置与推送订阅会被彻底清除，无法找回。想现在就彻底删除，管理员可执行
              <code className="mx-1 rounded bg-slate-100 px-1 py-0.5 text-[11px] dark:bg-slate-800">
                node server/src/cli/user.ts purge --username {session.user.username}
              </code>
              。删除前建议先自行备份。
            </p>
            <label className="block space-y-2">
              <span className="text-sm text-slate-600 dark:text-slate-300">输入当前口令确认</span>
              <input
                type="password"
                autoComplete="current-password"
                value={deletePassword}
                disabled={busy}
                onChange={(event) => setDeletePassword(event.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>
            <button
              type="button"
              disabled={busy || deletePassword === ''}
              onClick={() => {
                if (!window.confirm('确定要申请删除账号吗？7 天后数据会被彻底清除。')) return;
                void (async () => {
                  setBusy(true);
                  try {
                    await deleteAccount(deletePassword);
                    window.alert('已提交删除申请。本次会话已退出。');
                    onLogout();
                  } catch (caught) {
                    const status = caught instanceof ApiError ? caught.status : 0;
                    setError(status === 401 ? '口令不正确，未提交删除申请' : '删除申请失败，请稍后再试');
                    setDeletePassword('');
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
              className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950"
            >
              申请删除账号
            </button>
          </section>
        </>
      )}
    </AppShell>
  );
}
