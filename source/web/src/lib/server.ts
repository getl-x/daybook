/**
 * 服务器地址：默认不绑任何域名。
 *
 * 取值优先级（高 → 低）：
 *   1. 用户运行时填写的地址（localStorage，原生壳首次启动时要求填写）；
 *   2. 构建时注入的默认值（`VITE_DAYBOOK_SERVER_URL`，可选，给自建者发自己的包用）；
 *   3. 空串 = 与网页同源（浏览器里的 PWA 走相对路径）。
 *
 * 原生壳（Capacitor Android/iOS）的 WebView 源是 https://localhost，必须用绝对地址，
 * 所以首次启动会要求用户填写服务器地址。
 *
 * 本模块的模块级代码只碰 `import.meta.env`；`window` / `localStorage` 都推迟到函数调用时，
 * 这样纯函数可以在 Node（`node --test`）里直接跑单测。
 */

export const SERVER_KEY = 'daybook.server.v1';

/** 合法的服务器地址必须以 https:// 开头并带主机名（可带路径前缀）。 */
const HTTPS_BASE_PATTERN = /^https:\/\/[^\s/]+/;

/** trim + 去掉尾部斜杠；空串返回 ''；非空但不符合 https:// 形式时也返回 ''。 */
export function normalizeServerBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  if (!HTTPS_BASE_PATTERN.test(trimmed)) return '';
  return trimmed;
}

/** '' 视为合法（= 与网页同源）；非空必须能通过 normalize。 */
export function isValidServerBase(raw: string): boolean {
  if (raw.trim() === '') return true;
  return normalizeServerBase(raw) !== '';
}

/** stored 非空就用它，否则用 buildDefault，再否则 ''。 */
export function resolveServerBase(stored: string, buildDefault: string = BUILD_DEFAULT): string {
  if (stored !== '') return stored;
  if (buildDefault !== '') return buildDefault;
  return '';
}

/**
 * 构建时默认值。Vite 会把 `import.meta.env.VITE_DAYBOOK_SERVER_URL` 静态替换成字符串字面量；
 * Node（跑纯函数单测）里 `import.meta.env` 不存在，try/catch 兜底成空串。
 */
function readBuildDefault(): string {
  try {
    return String(import.meta.env.VITE_DAYBOOK_SERVER_URL ?? '');
  } catch {
    return '';
  }
}
const BUILD_DEFAULT = normalizeServerBase(readBuildDefault());

/** 读取用户保存的地址（localStorage 不可用时返回 ''）。 */
export function loadServerBase(): string {
  try {
    return localStorage.getItem(SERVER_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 保存地址（保存前先 normalize；空串等于清除，回到“未设置”）。 */
export function saveServerBase(raw: string): void {
  try {
    const value = normalizeServerBase(raw);
    if (value === '') localStorage.removeItem(SERVER_KEY);
    else localStorage.setItem(SERVER_KEY, value);
  } catch {
    // localStorage 不可用（隐私模式 / 无存储）：静默忽略
  }
}

export function clearServerBase(): void {
  try {
    localStorage.removeItem(SERVER_KEY);
  } catch {
    // 同上
  }
}

/** 当前生效的服务器地址（含构建时默认值）。 */
export function serverBase(): string {
  return resolveServerBase(loadServerBase());
}

/** 是否在 Capacitor 原生壳里（Capacitor 会注入全局 `window.Capacitor`，无需 import）。 */
export function isNativeShell(): boolean {
  return typeof window !== 'undefined' && (window as any).Capacitor?.isNativePlatform?.() === true;
}
