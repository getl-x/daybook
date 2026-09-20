import type { ReactNode } from 'react';
import { hrefCalendar, hrefSettings, hrefToday, monthOfLocalToday, useRoute } from '../lib/router.ts';

interface Props {
  title: string;
  subtitle: string;
  onLogout(): void;
  children: ReactNode;
}

export function BookMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M5 3.5h12a2 2 0 0 1 2 2V21H6a3 3 0 0 1-3-3V5.5a2 2 0 0 1 2-2Z" />
      <path d="M7 3.5V17m-4 1a2 2 0 0 1 2-2h14M11 7h4m-4 3h4" />
    </svg>
  );
}

function NavIcon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'today' ? (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
        </>
      ) : name === 'calendar' ? (
        <>
          <rect x="4" y="5" width="16" height="16" rx="3" />
          <path d="M8 3v4m8-4v4M4 11h16m-11 4h.01M12 15h.01M16 15h.01" />
        </>
      ) : (
        <>
          <path d="M4 7h16M4 17h16" />
          <circle cx="9" cy="7" r="2.5" fill="var(--paper)" />
          <circle cx="15" cy="17" r="2.5" fill="var(--paper)" />
        </>
      )}
    </svg>
  );
}

export function AppShell({ title, subtitle, onLogout, children }: Props) {
  const route = useRoute();
  const month =
    route.name === 'calendar'
      ? route.month
      : route.name === 'day'
        ? route.date.slice(0, 7)
        : monthOfLocalToday();
  const active =
    route.name === 'today'
      ? 'today'
      : route.name === 'settings'
        ? 'settings'
        : route.name === 'install'
          ? ''
          : 'calendar';
  const tabs = [
    { key: 'today', label: '今日', detail: '把今天留在这里', href: hrefToday() },
    { key: 'calendar', label: '日历', detail: '回看走过的日子', href: hrefCalendar(month) },
    { key: 'settings', label: '设置', detail: '找到自己的节奏', href: hrefSettings() },
  ];
  return (
    <div className="app-layout">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        跳到内容
      </a>
      <aside className="app-sidebar">
        <a href={hrefToday()} className="brand">
          <span className="brand-mark">
            <BookMark />
          </span>
          <span>
            daybook<small>日子，值得记下来</small>
          </span>
        </a>
        <p className="sidebar-label">我的日记</p>
        <nav className="app-navigation" aria-label="主导航">
          {tabs.map((tab) => (
            <a
              key={tab.key}
              href={tab.href}
              aria-current={active === tab.key ? 'page' : undefined}
              className={`nav-item ${active === tab.key ? 'is-active' : ''}`}
            >
              <NavIcon name={tab.key} />
              <span>
                {tab.label}
                <small>{tab.detail}</small>
              </span>
            </a>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="little-leaf">✳</span>
          <p>
            不必每一天都特别。
            <br />
            平常的日子，也值得珍藏。
          </p>
          <span>ONE DAY AT A TIME</span>
        </div>
        <button type="button" className="sidebar-logout" onClick={onLogout}>
          退出登录 <span aria-hidden="true">↗</span>
        </button>
      </aside>
      <div className="app-body">
        <header className="app-header">
          <a className="mobile-brand" href={hrefToday()}>
            <BookMark />
            daybook
          </a>
          <span className="header-context">你的私人日记空间</span>
          <span className="header-tag">慢慢写，慢慢生活</span>
          <button type="button" className="mobile-logout" onClick={onLogout}>
            退出
          </button>
        </header>
        <main id="main-content" className="app-main" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {active === 'today'
                  ? 'A LITTLE SPACE FOR TODAY'
                  : active === 'calendar'
                    ? 'DAYS TO REMEMBER'
                    : 'MAKE IT YOURS'}
              </p>
              <h1>{title}</h1>
              <p className="page-subtitle">{subtitle}</p>
            </div>
            <span className="heading-ornament" aria-hidden="true">
              ✳
            </span>
          </div>
          <div className="page-content">{children}</div>
          <footer className="page-footer">
            daybook <span>·</span> 留住日常的微光
          </footer>
        </main>
      </div>
    </div>
  );
}
