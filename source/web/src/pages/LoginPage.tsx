import { useState, type FormEvent } from 'react';

import { BookMark } from '../components/AppShell.tsx';
import { ApiError, login, type Session } from '../lib/api.ts';
import {
  isNativeShell,
  isValidServerBase,
  normalizeServerBase,
  saveServerBase,
  serverBase,
} from '../lib/server.ts';

interface Props {
  onLoggedIn: (session: Session) => void;
}

export function LoginPage({ onLoggedIn }: Props) {
  // 原生壳（APK）必须用绝对地址；浏览器里的 PWA 与后端同源，无需这个字段
  const native = isNativeShell();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState(() => serverBase());
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setServerError(null);

    if (native) {
      const trimmed = server.trim();
      if (trimmed !== '') {
        const normalized = normalizeServerBase(trimmed);
        if (!isValidServerBase(trimmed) || normalized === '') {
          setServerError('要填以 https:// 开头的完整地址');
          return;
        }
        saveServerBase(normalized);
      } else {
        // 空值允许：等于同源（若构建时预设有默认值，则回落到默认值）
        saveServerBase('');
      }
      if (serverBase() === '') {
        setServerError('请先填写服务器地址');
        return;
      }
    }

    setPending(true);
    try {
      onLoggedIn(await login(username, password));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '登录失败，请稍后再试');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="login-layout">
      <div className="login-story">
        <div className="brand">
          <span className="brand-mark">
            <BookMark />
          </span>
          <span>
            daybook<small>日子，值得记下来</small>
          </span>
        </div>
        <h1>
          给平常的日子，
          <br />
          留一页位置。
        </h1>
        <p>
          早晨的一点期待，午后的一闪念，
          <br />
          还有睡前想对自己说的话。
        </p>
        <div className="login-paper">
          <span>YOUR EVERYDAY, REMEMBERED</span>
          <p>
            无需写得漂亮。
            <br />
            真实，就很好。
          </p>
        </div>
      </div>
      <form onSubmit={handleSubmit} className="login-form space-y-5">
        <div className="space-y-1">
          <p className="eyebrow">WELCOME BACK</p>
          <h2>欢迎回来</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">登录，继续书写你的日常。</p>
        </div>

        {native ? (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">服务器地址</span>
            <input
              name="server"
              type="url"
              value={server}
              onChange={(event) => setServer(event.target.value)}
              placeholder="https://diary.example.com"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none focus:border-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-300"
            />
            <span className="block text-xs text-slate-400 dark:text-slate-500">
              你自建服务器的完整地址（必须 https://），填一次会记住
            </span>
            {serverError ? (
              <span className="block text-xs text-red-600 dark:text-red-400">{serverError}</span>
            ) : null}
          </label>
        ) : null}

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">用户名</span>
          <input
            name="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            required
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none focus:border-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-300"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">口令</span>
          <input
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none focus:border-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-300"
          />
        </label>

        {error ? (
          <p
            role="alert"
            className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300"
          >
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={pending} className="button-primary w-full">
          {pending ? '正在登录…' : '登录'}
        </button>

        <p className="text-center text-xs text-slate-400 dark:text-slate-500">
          账号由管理员在服务器上创建（注册已关闭）
        </p>
      </form>
    </main>
  );
}
