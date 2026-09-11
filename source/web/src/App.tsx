import { useCallback, useEffect, useState } from 'react';

import { fetchSettings, loadSession, logout as revokeSession, type Session } from './lib/api.ts';
import { disposeNativeSyncHooks, registerNativeSyncHooks } from './lib/notifications/native.ts';
import { toReminderSettings } from './lib/notifications/plan.ts';
import { useRoute } from './lib/router.ts';
import { isNativeShell } from './lib/server.ts';
import { CalendarPage } from './pages/CalendarPage.tsx';
import { DayDetailPage } from './pages/DayDetailPage.tsx';
import { InstallGuidePage } from './pages/InstallGuidePage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { TodayPage } from './pages/TodayPage.tsx';

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const route = useRoute();

  const handleLogout = useCallback(() => {
    // 先清本地会话切回登录页，同时通知服务端吊销 refresh 令牌（失败也不阻塞）
    setSession(null);
    void revokeSession();
  }, []);

  // 原生壳（APK）里注册本地提醒同步钩子：登录后同步一次，回前台重同步；登出时注销。
  // 浏览器里 `isNativeShell()` 为 false，这段完全不执行，PWA 行为不受影响。
  useEffect(() => {
    if (!session || !isNativeShell()) return;
    registerNativeSyncHooks(async () => {
      try {
        return toReminderSettings(await fetchSettings());
      } catch {
        return null;
      }
    });
    return () => disposeNativeSyncHooks();
  }, [session]);

  if (!session) return <LoginPage onLoggedIn={setSession} />;

  if (route.name === 'calendar') {
    return <CalendarPage key={route.month} session={session} month={route.month} onLogout={handleLogout} />;
  }
  if (route.name === 'day') {
    return <DayDetailPage key={route.date} session={session} date={route.date} onLogout={handleLogout} />;
  }
  if (route.name === 'install') {
    return <InstallGuidePage session={session} onLogout={handleLogout} />;
  }
  if (route.name === 'settings') {
    return <SettingsPage session={session} onLogout={handleLogout} />;
  }
  return <TodayPage session={session} onLogout={handleLogout} />;
}
