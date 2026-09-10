import { useState } from 'react';

import { AppShell } from '../components/AppShell.tsx';
import { Banner } from '../components/ui.tsx';
import type { Session } from '../lib/api.ts';
import {
  NOTIFICATION_STATE_LABELS,
  detectPlatform,
  isSecureContextOk,
  notificationState,
  type NotificationState,
  type Platform,
} from '../lib/device.ts';
import { hrefSettings } from '../lib/router.ts';

interface Props {
  session: Session;
  onLogout(): void;
}

const IOS_STEPS: { title: string; detail: string }[] = [
  {
    title: '用 Safari 打开这个网址',
    detail: '必须是 Safari——微信、Chrome 之类的内置浏览器不能"添加到主屏幕"。',
  },
  {
    title: '点底部中间的「分享」按钮',
    detail: '就是那个方框里带向上箭头的图标。',
  },
  {
    title: '往下找到「添加到主屏幕」，再点「添加」',
    detail: '名字可以改成"日记"，之后桌面就会出现一个图标。',
  },
  {
    title: '回主屏幕，从这个图标打开',
    detail: '这一步不能省：只有装在主屏幕的 Web App 才能收到提醒，普通 Safari 标签页收不到。',
  },
  {
    title: '在应用里点「开启每日提醒」，弹窗选「允许」',
    detail: '授权必须由你自己点一下触发，iOS 不允许网页自己弹权限框。',
  },
];

const PLATFORM_LABELS: Record<Platform, string> = {
  'ios-safari': 'iPhone / iPad · Safari 标签页',
  'ios-standalone': 'iPhone / iPad · 已添加到主屏幕',
  android: 'Android 浏览器',
  desktop: '电脑浏览器',
};

/** 安装与提醒引导页（计划 §8.4）：不做转化漏斗，只把该说的说清楚。 */
export function InstallGuidePage({ session, onLogout }: Props) {
  const [platform] = useState<Platform>(() => detectPlatform());
  const [permission, setPermission] = useState<NotificationState>(() => notificationState());
  const [rechecked, setRechecked] = useState(false);

  const secure = isSecureContextOk();

  return (
    <AppShell
      title="安装与提醒"
      subtitle={`${session.user.username} · ${PLATFORM_LABELS[platform]}`}
      onLogout={onLogout}
    >
      {platform === 'ios-standalone' ? (
        <Banner tone="info">已安装到主屏幕 ✓ 从主屏图标打开时，才能收到每日提醒。</Banner>
      ) : platform === 'ios-safari' ? (
        <Banner tone="warn">还没有安装到主屏幕。按下面 5 步做一次，之后就能收到提醒了。</Banner>
      ) : (
        <Banner tone="info">
          安卓和电脑浏览器可以直接用，也可以把它装成应用：安卓 Chrome 菜单里的「安装应用 / 添加到主屏幕」，电脑 Chrome
          地址栏右侧的安装图标。
        </Banner>
      )}

      {platform === 'ios-safari' || platform === 'ios-standalone' ? (
        <section className="space-y-3 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">iPhone / iPad 安装步骤</h2>
          <ol className="space-y-3">
            {IOS_STEPS.map((step, index) => (
              <li key={step.title} className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-medium text-white dark:bg-slate-100 dark:text-slate-900">
                  {index + 1}
                </span>
                <div>
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{step.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="space-y-3 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">提醒状态</h2>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500 dark:text-slate-400">通知权限</dt>
            <dd className="font-medium text-slate-800 dark:text-slate-100">{NOTIFICATION_STATE_LABELS[permission]}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500 dark:text-slate-400">安全上下文（HTTPS）</dt>
            <dd className="font-medium text-slate-800 dark:text-slate-100">{secure ? '是' : '否（提醒会不可用）'}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500 dark:text-slate-400">运行方式</dt>
            <dd className="font-medium text-slate-800 dark:text-slate-100">{PLATFORM_LABELS[platform]}</dd>
          </div>
        </dl>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <a
            href={hrefSettings()}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            去设置里开启每日提醒
          </a>
          <button
            type="button"
            onClick={() => {
              setPermission(notificationState());
              setRechecked(true);
            }}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            重新检查
          </button>
          {rechecked ? <span className="text-xs text-slate-400">已重新读取系统状态</span> : null}
        </div>

        {permission === 'denied' ? (
          <Banner tone="warn">
            系统里已经拒绝过通知。手动打开：iOS「设置 → 通知 → daybook → 允许通知」；安卓「设置 → 应用 → daybook →
            通知」。改完回到这里点「重新检查」。
          </Banner>
        ) : null}

        {!secure ? (
          <Banner tone="error">
            现在不是 HTTPS（或不是 localhost），浏览器不会允许通知。请通过你的域名访问，或先用
            `http://127.0.0.1:8090` 在本机调试。
          </Banner>
        ) : null}
      </section>

      <section className="space-y-2 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">关于送达时间</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          默认每天早上 9:00、晚上 21:00 各提醒一次，时间可以在设置里改。
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          提醒由服务端在你设定的时间发给你，但<strong className="font-medium">不保证正好整点</strong>
          ：浏览器的推送要经过系统通知服务，可能被延迟、合并，省电模式下也可能晚一些。它不会漏掉你写日记这件事，
          只是别拿它当闹钟。
        </p>
      </section>
    </AppShell>
  );
}
