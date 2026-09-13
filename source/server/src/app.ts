/**
 * Fastify 应用装配：/healthz、认证、日记、突发事情与日历接口。
 *
 * 设计要点：
 *  - 应用只依赖 `AppStore` 这个窄接口（DB 实现在 src/db/store.ts），
 *    因此接口层可以完全不连数据库就用 `app.inject()` 测（见 test/*.test.ts）；
 *  - 登录失败**一律**返回同一个 `invalid_credentials`，且用户不存在时也跑一次
 *    scrypt（DUMMY_HASH），避免用响应内容或耗时区分"用户不存在"与"密码错"；
 *  - 受保护接口用 Bearer 令牌，且每次校验都会查一次"账号状态 + 会话是否仍然有效"
 *    （一句 JOIN 查询）——因此停用账号、登出、令牌轮转都是**立即**生效的；
 *  - 认证失败**抛 UnauthorizedError** 而不是就地 reply：就地 reply 之后 handler
 *    还会继续跑并返回值，Fastify 会再发一次响应（FST_ERR_REP_ALREADY_SENT）；
 *  - 错误处理：401 映射；5xx 只回 `internal_error`（内部错误详情只进日志，不回给客户端）；
 *  - 突发事情的归属日由**服务端**按 occurred_at + 用户时区 + 日界算，
 *    因此创建接口不接受日期参数（改了时间归属日会跟着变，计划 §5.4）；
 *  - 设置与推送订阅的接口在 routes-notifications.ts，这里注册进去（共用同一个 authenticate）。
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  DUMMY_HASH,
  createRefreshToken,
  hashRefreshToken,
  isValidUsername,
  newSessionId,
  normalizeUsername,
  refreshTokenExpiresAt,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from './auth.ts';
import { DEFAULT_CORS_ORIGINS, type Config } from './config.ts';
import {
  DiaryError,
  INCIDENT_TAGS,
  MAX_INCIDENT_LENGTH,
  computeProgress,
  emptyEntry,
  incidentEntryDate,
  isDiaryTextField,
  isIncidentTag,
  isReasonableInstant,
  monthRange,
  normalizeBaseUpdatedAt,
  normalizeFieldValue,
  normalizeIncidentInput,
  todayMeta,
  type CalendarDay,
  type DiaryEntry,
  type FieldUpdate,
  type Incident,
  type IncidentInput,
  type PatchResult,
} from './diary.ts';
import type { NotificationStore } from './notifications.ts';
import { registerNotificationRoutes } from './routes-notifications.ts';

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  status: 'active' | 'disabled' | 'pending_deletion';
}

export interface UserSettings {
  timezone: string;
  dayStartHour: number;
}

export interface CreateSessionInput {
  userId: string;
  sessionId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  /** 由哪一个会话轮转而来（审计用） */
  rotatedFrom?: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface IncidentChanges {
  content?: string;
  occurredAt?: string;
  tag?: string | null;
  /** 由 occurredAt 变化推导出来的新归属日 */
  entryDate?: string;
}

export interface AppStore {
  /** /healthz 用：能不能连通数据库 */
  ping(): Promise<void>;
  findUserByUsername(username: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  /** 认证用：账号 active 且该会话未被吊销/过期，才返回用户 */
  findLiveSession(userId: string, sessionId: string, at: Date): Promise<UserRecord | null>;
  createSession(input: CreateSessionInput): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  /** 返回 true 表示这次真的吊销了（CAS）；false = 之前已经吊销过 */
  revokeSession(sessionId: string, at: Date): Promise<boolean>;
  touchLastLogin(userId: string, at: Date): Promise<void>;
  /** 申请删除账号：吊销会话、清订阅、停排程，进入宽限期 */
  requestAccountDeletion(userId: string, at: Date): Promise<void>;
  getUserSettings(userId: string): Promise<UserSettings>;
  getDiaryEntry(userId: string, entryDate: string): Promise<DiaryEntry | null>;
  upsertDiaryFields(
    userId: string,
    entryDate: string,
    updates: readonly FieldUpdate[],
    at: Date,
  ): Promise<PatchResult>;
  listIncidents(userId: string, entryDate: string): Promise<Incident[]>;
  /** null = 该 id 被别的用户占了（客户端 UUID 撞车） */
  createIncident(
    userId: string,
    input: IncidentInput & { entryDate: string },
  ): Promise<{ incident: Incident; created: boolean } | null>;
  updateIncident(userId: string, id: string, changes: IncidentChanges): Promise<Incident | null>;
  deleteIncident(userId: string, id: string): Promise<boolean>;
  listEntryDates(userId: string, startDate: string, endDate: string): Promise<CalendarDay[]>;
  /** 应用级键值设置（如自动生成的 VAPID 密钥，见 src/vapid.ts） */
  getAppSetting(key: string): Promise<string | null>;
  setAppSetting(key: string, value: string): Promise<void>;
}

export interface BuildAppOptions {
  config: Config;
  /** 提醒与推送相关的能力见 src/notifications.ts 的 NotificationStore */
  store: AppStore & NotificationStore;
  /** 便于测试注入固定时间 */
  now?: () => Date;
}

/** 认证失败：由统一的错误处理映射成 401 */
export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'UnauthorizedError';
  }
}

/** 固定窗口限流器（浏览器/Node 都有 Map，够用且零依赖）。 */
export class LoginRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  // 注意：Node 的类型擦除（strip-only）不支持构造器参数属性，字段必须显式声明 + 赋值
  private readonly limit: number;
  private readonly windowMs: number;
  /** 超过这个条目数就顺手清理过期项，避免长期运行时 Map 只增不减 */
  private readonly maxEntries: number;

  constructor(limit = 5, windowMs = 15 * 60 * 1000, maxEntries = 5000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
  }

  /** true = 允许这次尝试；false = 已超限 */
  attempt(key: string, at: Date): boolean {
    const nowMs = at.getTime();
    if (this.hits.size > this.maxEntries) this.sweep(nowMs);

    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= nowMs) {
      this.hits.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  private sweep(nowMs: number): void {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= nowMs) this.hits.delete(key);
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  clear(): void {
    this.hits.clear();
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 日期必须是真实存在的日历日（2026-02-31 这种要被拒，否则会以 500 的形式炸在数据库那层） */
export function isValidDateParam(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  if (value < '1900-01-01' || value > '2200-12-31') return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export interface AuthContext {
  userId: string;
  sessionId: string;
}

export function buildApp({ config, store, now = () => new Date() }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            // 日志里绝不出现令牌
            redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
          },
    // 容器只监听回环/容器网络，前面一定有一层反代（见计划 §7.1）：
    // 不开里这个开关，request.ip 永远是反代的地址，登录限流会变成"所有人共用一个桶"。
    trustProxy: true,
  });

  // 跨源：浏览器里的 PWA 与后端同源，用不到；Android APK 的 WebView 源是 https://localhost。
  // 只放行名单里的源（默认见 DEFAULT_CORS_ORIGINS），不开 credentials（令牌走 Authorization 头）。
  void app.register(cors, {
    origin: [...(config.corsOrigins ?? DEFAULT_CORS_ORIGINS)],
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type'],
    maxAge: 86400,
  });

  const perUsername = new LoginRateLimiter(5, 15 * 60 * 1000);
  const perIp = new LoginRateLimiter(30, 15 * 60 * 1000);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof UnauthorizedError) {
      void reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    // Fastify 的类型在这里给的是 unknown，取状态码要自己收窄
    const { statusCode } = error as { statusCode?: unknown };
    const status = typeof statusCode === 'number' ? statusCode : 500;
    if (status >= 500) {
      // 内部错误只进日志：不回数据库错误原文/堆栈（可能带表名、约束名甚至数据片段）
      request.log.error({ err: error }, '请求处理失败');
      void reply.code(500).send({ error: 'internal_error' });
      return;
    }

    // 4xx（含 JSON Schema 校验）保留 Fastify 的细节
    void reply.send(error);
  });

  /**
   * Bearer 认证：验签 + 过期 + **账号状态与会话有效性**（一句 JOIN 查询）。
   * 失败时抛 UnauthorizedError（不要在这里 reply，否则 handler 会二次回应）。
   */
  async function authenticate(request: FastifyRequest): Promise<AuthContext> {
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) throw new UnauthorizedError();

    const at = now();
    const claims = verifyAccessToken(token, config.jwtSecret, at);
    if (!claims) throw new UnauthorizedError();

    const user = await store.findLiveSession(claims.sub, claims.sid, at);
    if (!user || user.status !== 'active') throw new UnauthorizedError();

    return { userId: user.id, sessionId: claims.sid };
  }

  function issueSession(userId: string, at: Date, rotatedFrom?: string) {
    const sessionId = newSessionId();
    const refresh = createRefreshToken();
    const expiresAt = refreshTokenExpiresAt(at);
    return {
      sessionId,
      refresh,
      expiresAt,
      payload: {
        accessToken: signAccessToken(userId, sessionId, config.jwtSecret, ACCESS_TOKEN_TTL_SECONDS, at),
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshToken: refresh.token,
        refreshExpiresAt: expiresAt.toISOString(),
        rotatedFrom,
      },
    };
  }

  /* ------------------------------- 探针 ------------------------------- */

  app.get('/healthz', async (_request, reply) => {
    try {
      await store.ping();
      return { status: 'ok', db: 'ok', time: now().toISOString() };
    } catch {
      reply.code(503);
      return { status: 'degraded', db: 'error', time: now().toISOString() };
    }
  });

  /* ------------------------------- 认证 ------------------------------- */

  app.post(
    '/v1/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
            password: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const { username, password } = request.body as { username: string; password: string };
      const at = now();
      const normalized = normalizeUsername(username);

      const allowed =
        perUsername.attempt(`u:${normalized}`, at) && perIp.attempt(`ip:${request.ip ?? 'unknown'}`, at);
      if (!allowed) {
        reply.code(429);
        return { error: 'too_many_attempts' };
      }

      // 用户名不合法就不用查库，但依然走一次等价的 KDF，保持时序一致
      const user = isValidUsername(normalized) ? await store.findUserByUsername(normalized) : null;
      if (!user) {
        await verifyPassword(password, DUMMY_HASH);
        reply.code(401);
        return { error: 'invalid_credentials' };
      }

      const passwordOk = await verifyPassword(password, user.passwordHash);
      if (!passwordOk || user.status !== 'active') {
        reply.code(401);
        return { error: 'invalid_credentials' };
      }

      const session = issueSession(user.id, at);
      await store.createSession({
        userId: user.id,
        sessionId: session.sessionId,
        refreshTokenHash: session.refresh.hash,
        expiresAt: session.expiresAt,
      });
      await store.touchLastLogin(user.id, at);
      // 登录成功只清该用户名的失败计数；IP 计数保留（否则拿到一个有效账号就能无限试别人）
      perUsername.reset(`u:${normalized}`);

      return { user: { id: user.id, username: user.username }, ...session.payload };
    },
  );

  app.post(
    '/v1/auth/refresh',
    {
      schema: {
        body: {
          type: 'object',
          required: ['refreshToken'],
          additionalProperties: false,
          properties: { refreshToken: { type: 'string', minLength: 20, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const { refreshToken } = request.body as { refreshToken: string };
      const at = now();

      const session = await store.findSessionByTokenHash(hashRefreshToken(refreshToken));
      const usable =
        session !== null && session.revokedAt === null && session.expiresAt.getTime() > at.getTime();
      if (!usable) {
        reply.code(401);
        return { error: 'invalid_refresh_token' };
      }

      const user = await store.findUserById(session.userId);
      if (!user || user.status !== 'active') {
        reply.code(401);
        return { error: 'invalid_refresh_token' };
      }

      // 轮转：用条件更新做 CAS——并发/重放时只有一个请求能抢到，另一个会被拒
      const rotated = await store.revokeSession(session.id, at);
      if (!rotated) {
        request.log.warn({ userId: user.id, sessionId: session.id }, 'refresh token 被重复使用，已拒绝');
        reply.code(401);
        return { error: 'invalid_refresh_token' };
      }

      const next = issueSession(user.id, at, session.id);
      await store.createSession({
        userId: user.id,
        sessionId: next.sessionId,
        refreshTokenHash: next.refresh.hash,
        expiresAt: next.expiresAt,
        rotatedFrom: session.id,
      });

      return { user: { id: user.id, username: user.username }, ...next.payload };
    },
  );

  app.post(
    '/v1/auth/logout',
    {
      schema: {
        body: {
          type: 'object',
          required: ['refreshToken'],
          additionalProperties: false,
          properties: { refreshToken: { type: 'string', minLength: 20, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const { refreshToken } = request.body as { refreshToken: string };
      const session = await store.findSessionByTokenHash(hashRefreshToken(refreshToken));
      if (session) await store.revokeSession(session.id, now());
      reply.code(204);
      return null;
    },
  );

  /* ------------------------------ 账号删除 ------------------------------ */

  /**
   * 删除账号（验收标准第 10 条）：口令确认 → 立刻吊销全部会话、清订阅、停提醒，
   * 进入 7 天宽限期；到期后由后台任务真正清除（见 users.ts 的 purgeExpiredAccounts）。
   */
  app.delete('/v1/account', async (request, reply) => {
    const auth = await authenticate(request);
    const body = (request.body ?? {}) as { password?: unknown };

    if (typeof body.password !== 'string' || body.password === '') {
      reply.code(400);
      return { error: 'password_required', message: '删除账号需要输入当前口令确认' };
    }

    const user = await store.findUserById(auth.userId);
    if (!user || user.status !== 'active') throw new UnauthorizedError();

    const confirmed = await verifyPassword(body.password, user.passwordHash);
    if (!confirmed) {
      await verifyPassword(body.password, DUMMY_HASH); // 时序对齐
      reply.code(401);
      return { error: 'invalid_credentials' };
    }

    await store.requestAccountDeletion(auth.userId, now());
    reply.code(204);
    return null;
  });

  /* ----------------------------- 元信息与日记 ---------------------------- */

  app.get('/v1/meta/today', async (request) => {
    const auth = await authenticate(request);
    const settings = await store.getUserSettings(auth.userId);
    return { ...todayMeta({ now: now(), settings }), user_id: auth.userId };
  });

  app.get('/v1/diaries/today', async (request) => {
    const auth = await authenticate(request);
    const settings = await store.getUserSettings(auth.userId);
    const meta = todayMeta({ now: now(), settings });

    const [today, yesterday, incidents] = await Promise.all([
      store.getDiaryEntry(auth.userId, meta.diary_date),
      store.getDiaryEntry(auth.userId, meta.yesterday),
      store.listIncidents(auth.userId, meta.diary_date),
    ]);

    const todayEntry = today ?? emptyEntry(meta.diary_date);
    const yesterdayEntry = yesterday ?? emptyEntry(meta.yesterday);

    return {
      meta,
      today: todayEntry,
      yesterday: yesterdayEntry,
      incidents,
      progress: computeProgress(todayEntry),
    };
  });

  app.get<{ Params: { date: string } }>('/v1/diaries/:date', async (request, reply) => {
    const auth = await authenticate(request);

    const { date } = request.params;
    if (!isValidDateParam(date)) {
      reply.code(400);
      return { error: 'invalid_date' };
    }

    const [entry, incidents] = await Promise.all([
      store.getDiaryEntry(auth.userId, date),
      store.listIncidents(auth.userId, date),
    ]);

    return { entry: entry ?? emptyEntry(date), incidents };
  });

  /**
   * 字段级写入：只提交变更字段。
   * 冲突不算失败——仍按后写优先，但该字段返回 overwritten=true，由前端提示用户。
   * 清空某个字段请提交空串（`value: ""`），不要提交 null。
   */
  app.patch<{ Params: { date: string } }>('/v1/diaries/:date', async (request, reply) => {
    const auth = await authenticate(request);

    const { date } = request.params;
    if (!isValidDateParam(date)) {
      reply.code(400);
      return { error: 'invalid_date' };
    }

    const body = request.body as { fields?: Record<string, { value?: unknown; base_updated_at?: unknown }> };
    const rawFields = body?.fields ?? {};
    const names = Object.keys(rawFields);
    if (names.length === 0) {
      reply.code(400);
      return { error: 'no_fields' };
    }

    const updates: FieldUpdate[] = [];
    try {
      for (const name of names) {
        if (!isDiaryTextField(name)) {
          reply.code(400);
          return { error: 'invalid_field', field: name };
        }
        const raw = rawFields[name] ?? {};
        updates.push({
          field: name,
          value: normalizeFieldValue(name, raw.value),
          baseUpdatedAt: normalizeBaseUpdatedAt(raw.base_updated_at),
        });
      }
    } catch (error) {
      if (error instanceof DiaryError) {
        reply.code(400);
        return { error: error.code, message: error.message };
      }
      throw error;
    }

    return await store.upsertDiaryFields(auth.userId, date, updates, now());
  });

  /* ----------------------------- 突发事情 ----------------------------- */

  /**
   * 新建一条突发事情。`id` 由客户端生成 → 重复提交幂等（重放返回 200 + created:false）。
   * 归属日不在这条接口里指定：由 occurred_at 推出来（改时间跨日 → 归属日跟着变）。
   */
  app.post('/v1/incidents', async (request, reply) => {
    const auth = await authenticate(request);
    const at = now();

    let input: IncidentInput;
    try {
      input = normalizeIncidentInput((request.body ?? {}) as Record<string, unknown>, { now: at });
    } catch (error) {
      if (error instanceof DiaryError) {
        reply.code(400);
        return { error: error.code, message: error.message };
      }
      throw error;
    }

    const settings = await store.getUserSettings(auth.userId);
    const entryDate = incidentEntryDate(input.occurredAt, settings);
    const created = await store.createIncident(auth.userId, { ...input, entryDate });
    if (!created) {
      reply.code(409);
      return { error: 'id_conflict' };
    }

    if (created.created) reply.code(201);
    return { incident: created.incident, created: created.created };
  });

  /** 改内容 / 时间 / 标签；改时间会重算归属日（跨日移动），前端据此提示用户。 */
  app.patch<{ Params: { id: string } }>('/v1/incidents/:id', async (request, reply) => {
    const auth = await authenticate(request);
    const { id } = request.params;
    if (!UUID_PATTERN.test(id)) {
      reply.code(400);
      return { error: 'invalid_id' };
    }

    const body = (request.body ?? {}) as { content?: unknown; occurred_at?: unknown; tag?: unknown };
    const settings = await store.getUserSettings(auth.userId);
    const changes: IncidentChanges = {};

    if (body.content !== undefined) {
      if (typeof body.content !== 'string') {
        reply.code(400);
        return { error: 'invalid_field', message: 'content 必须是字符串' };
      }
      const content = body.content.trim();
      if (content === '') {
        reply.code(400);
        return { error: 'invalid_field', message: 'content 不能为空' };
      }
      if (content.length > MAX_INCIDENT_LENGTH) {
        reply.code(400);
        return { error: 'too_long', message: `content 最多 ${MAX_INCIDENT_LENGTH} 个字符` };
      }
      changes.content = content;
    }

    if (body.tag !== undefined) {
      if (body.tag === null || body.tag === '') {
        changes.tag = null; // 允许清掉标签
      } else if (typeof body.tag === 'string' && isIncidentTag(body.tag)) {
        changes.tag = body.tag;
      } else {
        reply.code(400);
        return { error: 'invalid_field', message: `tag 只能是 ${INCIDENT_TAGS.join(' / ')}` };
      }
    }

    if (body.occurred_at !== undefined) {
      if (typeof body.occurred_at !== 'string' || !isReasonableInstant(body.occurred_at)) {
        reply.code(400);
        return { error: 'invalid_field', message: 'occurred_at 必须是 2000–2100 年之间的合法时间' };
      }
      changes.occurredAt = new Date(Date.parse(body.occurred_at)).toISOString();
      changes.entryDate = incidentEntryDate(changes.occurredAt, settings);
    }

    if (Object.keys(changes).length === 0) {
      reply.code(400);
      return { error: 'no_changes' };
    }

    const updated = await store.updateIncident(auth.userId, id, changes);
    if (!updated) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return { incident: updated };
  });

  app.delete<{ Params: { id: string } }>('/v1/incidents/:id', async (request, reply) => {
    const auth = await authenticate(request);
    const { id } = request.params;
    if (!UUID_PATTERN.test(id)) {
      reply.code(400);
      return { error: 'invalid_id' };
    }

    const deleted = await store.deleteIncident(auth.userId, id);
    if (!deleted) {
      reply.code(404);
      return { error: 'not_found' };
    }
    reply.code(204);
    return null;
  });

  app.get<{ Querystring: { date?: string } }>('/v1/incidents', async (request, reply) => {
    const auth = await authenticate(request);
    const date = request.query.date;
    if (!date || !isValidDateParam(date)) {
      reply.code(400);
      return { error: 'invalid_date' };
    }
    return { date, incidents: await store.listIncidents(auth.userId, date) };
  });

  /* ------------------------------- 日历 ------------------------------- */

  /** 某月里有记录的日期 + 每天的突发条数（日历格子上画点用）。 */
  app.get<{ Querystring: { month?: string } }>('/v1/calendar', async (request, reply) => {
    const auth = await authenticate(request);
    const month = request.query.month;
    if (!month) {
      reply.code(400);
      return { error: 'invalid_month', message: 'month 必填，格式 YYYY-MM' };
    }

    let range: { start: string; end: string };
    try {
      range = monthRange(month);
    } catch (error) {
      if (error instanceof DiaryError) {
        reply.code(400);
        return { error: error.code, message: error.message };
      }
      throw error;
    }

    return { month, days: await store.listEntryDates(auth.userId, range.start, range.end) };
  });

  /* --------------------------- 设置与推送订阅 --------------------------- */

  registerNotificationRoutes(app, { store, config, now, authenticate });

  return app;
}
