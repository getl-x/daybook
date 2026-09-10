import { useCallback, useState } from 'react';

import { loadSession, logout as revokeSession, type Session } from './lib/api.ts';
import { useRoute } from './lib/router.ts';
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
