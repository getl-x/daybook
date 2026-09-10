/**
 * API 客户端：会话、令牌刷新重试、日记/突发/日历的类型化封装。
 *
 * 令牌放 localStorage——个人自托管场景的有意取舍：少一层会话逻辑。
 * 代价是 XSS 可直接读走令牌，因此前端不引入任何第三方脚本、不渲染未转义的 HTML。
 */
export interface SessionUser {
  id: string;
  username: string;
}

export interface Session {
  user: SessionUser;
  accessToken: string;
  refreshToken: string;
  /** access 令牌过期时刻（毫秒时间戳） */
  expiresAt: number;
  refreshExpiresAt: string;
}

const STORAGE_KEY = 'daybook.session.v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(messageFor(code, status));
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function messageFor(code: string, status: number): string {
  switch (code) {
    case 'invalid_credentials':
      return '用户名或口令不对';
    case 'too_many_attempts':
      return '尝试次数太多，请 15 分钟后再试';
    case 'unauthorized':
      return '登录已过期，请重新登录';
    case 'not_found':
      return '服务未找到该接口（部署是否有误？）';
    case 'no_fields':
      return '没有需要保存的内容';
    default:
      return `请求失败（HTTP ${status}）`;
  }
}

export function loadSession(): Session | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.accessToken || !parsed.refreshToken || !parsed.user?.username) return null;
    return parsed as Session;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'unknown';
  try {
    const body = (await response.json()) as { error?: string };
    if (typeof body.error === 'string') code = body.error;
  } catch {
    // 响应不是 JSON，保持 unknown
  }
  return new ApiError(response.status, code);
}

function sessionFromLoginBody(body: {
  user: SessionUser;
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string;
}): Session {
  return {
    user: body.user,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    expiresAt: Date.now() + body.expiresIn * 1000,
    refreshExpiresAt: body.refreshExpiresAt,
  };
}

export async function login(username: string, password: string): Promise<Session> {
  const response = await fetch('/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw await toApiError(response);

  const session = sessionFromLoginBody(await response.json());
  saveSession(session);
  return session;
}

let refreshing: Promise<Session | null> | null = null;

/** 用 refresh token 换新令牌；并发调用只会真的刷一次。 */
async function refreshSession(): Promise<Session | null> {
  const current = loadSession();
  if (!current) return null;
  if (refreshing) return refreshing;

  refreshing = (async () => {
    try {
      const response = await fetch('/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!response.ok) {
        clearSession();
        return null;
      }
      const next = sessionFromLoginBody(await response.json());
      saveSession(next);
      return next;
    } catch {
      return null; // 网络问题：保留会话，等下一次重试
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

async function send(path: string, init: RequestInit, token: string | null): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return await fetch(path, { ...init, headers });
}

/**
 * 带 Bearer 的请求：401 时自动用 refresh token 换一次新令牌并重放原请求；
 * 仍然 401 就清掉会话并抛错（调用方切回登录页）。
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const session = loadSession();
  const response = await send(path, init, session?.accessToken ?? null);
  if (response.status !== 401) {
    if (!response.ok) throw await toApiError(response);
    return response;
  }

  const renewed = await refreshSession();
  if (!renewed) {
    clearSession();
    throw new ApiError(401, 'unauthorized');
  }

  const retried = await send(path, init, renewed.accessToken);
  if (retried.status === 401) {
    clearSession();
    throw new ApiError(401, 'unauthorized');
  }
  if (!retried.ok) throw await toApiError(retried);
  return retried;
}

export async function logout(): Promise<void> {
  const session = loadSession();
  clearSession();
  if (!session) return;
  try {
    await fetch('/v1/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
  } catch {
    // 登出失败不影响本地清除
  }
}

/* ------------------------------ 领域类型 ------------------------------ */

export const DIARY_FIELDS = ['day_events', 'day_meals', 'day_plan', 'evening_summary'] as const;
export type DiaryFieldName = (typeof DIARY_FIELDS)[number];

export interface DiaryFieldState {
  value: string | null;
  updatedAt: string | null;
}

export interface DiaryEntry {
  entryDate: string;
  exists: boolean;
  version: number;
  fields: Record<DiaryFieldName, DiaryFieldState>;
}

export interface TodayMeta {
  diary_date: string;
  yesterday: string;
  timezone: string;
  day_start_hour: number;
  server_time: string;
  user_id: string;
}

export interface Incident {
  id: string;
  entryDate: string;
  occurredAt: string;
  content: string;
  tag: string | null;
}

export interface TodayView {
  meta: TodayMeta;
  today: DiaryEntry;
  yesterday: DiaryEntry;
  incidents: Incident[];
  progress: { morningDone: boolean; eveningDone: boolean };
}

export interface FieldPatchResult {
  value: string;
  updatedAt: string;
  overwritten: boolean;
}

export interface PatchResponse {
  entryDate: string;
  version: number;
  fields: Partial<Record<DiaryFieldName, FieldPatchResult>>;
}

export interface Health {
  status: string;
  db: string;
  time: string;
}

export interface SettingsView {
  timezone: string;
  day_start_hour: number;
  reminders: {
    morning_enabled: boolean;
    morning_time: string;
    evening_enabled: boolean;
    evening_time: string;
    only_if_incomplete: boolean;
  };
  push: {
    /** 服务端没配 VAPID 时为 null（此时"开启每日提醒"不可用） */
    vapid_public_key: string | null;
    subscriptions: number;
  };
}

export interface NotificationStatus {
  vapid_public_key: string | null;
  push_configured: boolean;
  subscriptions: { id: string; created_at: string; failure_count: number }[];
  recent_deliveries: {
    local_date: string;
    kind: 'morning' | 'evening';
    status: 'pending' | 'sent' | 'failed' | 'skipped';
    attempts: number;
    last_error: string | null;
  }[];
  reminders: { morning_time: string; evening_time: string };
}

export async function fetchSettings(): Promise<SettingsView> {
  const response = await apiFetch('/v1/settings');
  return (await response.json()) as SettingsView;
}

export async function patchSettings(payload: Record<string, unknown>): Promise<SettingsView> {
  const response = await apiFetch('/v1/settings', { method: 'PATCH', body: JSON.stringify(payload) });
  return (await response.json()) as SettingsView;
}

export async function fetchNotificationStatus(): Promise<NotificationStatus> {
  const response = await apiFetch('/v1/notifications/status');
  return (await response.json()) as NotificationStatus;
}

export async function fetchTimezones(): Promise<string[]> {
  const response = await apiFetch('/v1/meta/timezones');
  return ((await response.json()) as { timezones: string[] }).timezones;
}

export async function deleteSubscription(id: string): Promise<void> {
  await apiFetch(`/v1/notifications/subscriptions/${id}`, { method: 'DELETE' });
}

export interface CalendarDay {
  date: string;
  hasContent: boolean;
  incidentCount: number;
}

export const INCIDENT_TAGS = ['work', 'life', 'emotion', 'idea', 'other'] as const;
export type IncidentTag = (typeof INCIDENT_TAGS)[number];

export const INCIDENT_TAG_LABELS: Record<IncidentTag, string> = {
  work: '工作',
  life: '生活',
  emotion: '情绪',
  idea: '灵感',
  other: '其他',
};

/* ------------------------------- 接口封装 ------------------------------- */

export async function fetchHealth(): Promise<Health> {
  const response = await fetch('/healthz');
  return (await response.json()) as Health;
}

export async function fetchToday(): Promise<TodayView> {
  const response = await apiFetch('/v1/diaries/today');
  return (await response.json()) as TodayView;
}

export async function fetchDate(date: string): Promise<{ entry: DiaryEntry; incidents: Incident[] }> {
  const response = await apiFetch(`/v1/diaries/${date}`);
  return (await response.json()) as { entry: DiaryEntry; incidents: Incident[] };
}

export async function patchDiary(
  date: string,
  fields: Partial<Record<DiaryFieldName, { value: string; base_updated_at: string | null }>>,
): Promise<PatchResponse> {
  const response = await apiFetch(`/v1/diaries/${date}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields }),
  });
  return (await response.json()) as PatchResponse;
}

export async function createIncident(input: {
  id: string;
  content: string;
  occurredAt: string;
  tag: IncidentTag | null;
}): Promise<{ incident: Incident; created: boolean }> {
  const response = await apiFetch('/v1/incidents', {
    method: 'POST',
    body: JSON.stringify({
      id: input.id,
      content: input.content,
      occurred_at: input.occurredAt,
      ...(input.tag ? { tag: input.tag } : {}),
    }),
  });
  return (await response.json()) as { incident: Incident; created: boolean };
}

export async function updateIncident(
  id: string,
  changes: { content?: string; occurredAt?: string; tag?: IncidentTag | null },
): Promise<{ incident: Incident }> {
  const body: Record<string, unknown> = {};
  if (changes.content !== undefined) body.content = changes.content;
  if (changes.occurredAt !== undefined) body.occurred_at = changes.occurredAt;
  if (changes.tag !== undefined) body.tag = changes.tag;

  const response = await apiFetch(`/v1/incidents/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  return (await response.json()) as { incident: Incident };
}

export async function deleteIncident(id: string): Promise<void> {
  await apiFetch(`/v1/incidents/${id}`, { method: 'DELETE' });
}

export async function fetchCalendar(month: string): Promise<{ month: string; days: CalendarDay[] }> {
  const response = await apiFetch(`/v1/calendar?month=${encodeURIComponent(month)}`);
  return (await response.json()) as { month: string; days: CalendarDay[] };
}

/**
 * 申请删除账号（需要当前口令确认）。服务端会立刻吊销全部会话、清掉推送订阅，
 * 并进入 7 天宽限期；到期后才真正清除数据。
 *
 * 这里**不走** apiFetch：那条路径遇到 401 会去刷新令牌、必要时还会退出登录——
 * 而"口令输错"也是 401，用它会把用户直接踢下线。
 */
export async function deleteAccount(password: string): Promise<void> {
  const session = loadSession();
  const response = await send(
    '/v1/account',
    { method: 'DELETE', body: JSON.stringify({ password }) },
    session?.accessToken ?? null,
  );
  if (response.status === 204) return;
  throw await toApiError(response);
}
