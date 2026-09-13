/**
 * 日记领域：类型、字段白名单、校验与纯逻辑。
 *
 * 设计要点（见 DAYBOOK-DESIGN.zh-CN.md §4）：
 *  - **当天字段模型**：一条记录描述"这一天自己"，昨日回顾只是填写入口；
 *  - **字段级写入**：PATCH 只提交变更字段，冲突按字段判（不是整行 LWW），
 *    检测到冲突仍然写入（后写优先），但返回 overwritten=true 让前端提示；
 *  - 完成状态是**派生**的（字段非空即完成），不存 completed_at。
 */
import { addDays, diaryDate, type ISODate } from '@daybook/shared';

export const DIARY_TEXT_FIELDS = ['day_events', 'day_meals', 'day_plan', 'evening_summary'] as const;
export type DiaryTextField = (typeof DIARY_TEXT_FIELDS)[number];

/** 单个正文上限（计划 §6.3） */
export const MAX_TEXT_LENGTH = 8000;

/** 回顾字段：早间页面写的是"昨天"那一行 */
export const REVIEW_FIELDS: readonly DiaryTextField[] = ['day_events', 'day_meals'];

export type DiaryFieldValue = string | null;

export interface DiaryFieldState {
  value: DiaryFieldValue;
  /** 服务端最后写入时间（ISO 字符串），null 表示从未写过 */
  updatedAt: string | null;
}

export interface DiaryEntry {
  entryDate: ISODate;
  /** 数据库里是否已有这一行 */
  exists: boolean;
  version: number;
  fields: Record<DiaryTextField, DiaryFieldState>;
}

export interface FieldUpdate {
  field: DiaryTextField;
  value: string;
  /** 客户端上次看到的该字段 updatedAt；null = 首次写入 */
  baseUpdatedAt: string | null;
}

export interface FieldPatchResult extends DiaryFieldState {
  overwritten: boolean;
}

export interface PatchResult {
  entryDate: ISODate;
  version: number;
  fields: Partial<Record<DiaryTextField, FieldPatchResult>>;
}

export type DiaryErrorCode = 'invalid_field' | 'too_long' | 'invalid_base_updated_at' | 'not_found';

export class DiaryError extends Error {
  readonly code: DiaryErrorCode;

  constructor(code: DiaryErrorCode, message: string) {
    super(message);
    this.name = 'DiaryError';
    this.code = code;
  }
}

export function isDiaryTextField(name: string): name is DiaryTextField {
  return (DIARY_TEXT_FIELDS as readonly string[]).includes(name);
}

export function emptyEntry(entryDate: ISODate): DiaryEntry {
  const fields = {} as Record<DiaryTextField, DiaryFieldState>;
  for (const field of DIARY_TEXT_FIELDS) fields[field] = { value: null, updatedAt: null };
  return { entryDate, exists: false, version: 0, fields };
}

/**
 * 字段级冲突判定：
 *  - 客户端没带 baseUpdatedAt → 视为首次写入，不算冲突；
 *  - 服务端还没有值 → 不算冲突；
 *  - 服务端的写入时间比客户端的基准更新 → 冲突（仍然写入，但要告诉用户）。
 */
export function isOverwritten(baseUpdatedAt: string | null, currentUpdatedAt: string | null): boolean {
  if (!baseUpdatedAt || !currentUpdatedAt) return false;
  const base = Date.parse(baseUpdatedAt);
  const current = Date.parse(currentUpdatedAt);
  if (Number.isNaN(base) || Number.isNaN(current)) return false;
  return current > base;
}

/** 校验并归一化要写入的字段值：去尾空白、限长、允许空串（= 清空内容）。 */
export function normalizeFieldValue(field: DiaryTextField, raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new DiaryError('invalid_field', `字段 ${field} 的值必须是字符串`);
  }
  const value = raw.replace(/\s+$/u, '');
  if (value.length > MAX_TEXT_LENGTH) {
    throw new DiaryError('too_long', `字段 ${field} 超长：最多 ${MAX_TEXT_LENGTH} 个字符，收到 ${value.length}`);
  }
  return value;
}

export function normalizeBaseUpdatedAt(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new DiaryError('invalid_base_updated_at', 'base_updated_at 必须是 ISO 时间字符串或 null');
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new DiaryError('invalid_base_updated_at', `base_updated_at 不是合法时间：${raw}`);
  return new Date(parsed).toISOString();
}

export interface Progress {
  morningDone: boolean;
  eveningDone: boolean;
}

/**
 * 今日页进度：早间 = 今天的 day_plan 已写；晚间 = 今天的 evening_summary 已写。
 * 两边的"完成"都只看当天那一行——早间记录里已经没有"昨日回顾"了。
 */
export function computeProgress(today: DiaryEntry): Progress {
  const hasText = (state: DiaryFieldState | undefined): boolean =>
    typeof state?.value === 'string' && state.value.trim() !== '';

  return {
    morningDone: hasText(today.fields.day_plan),
    eveningDone: hasText(today.fields.evening_summary),
  };
}

/* ------------------------------ 今日视图与突发事情 ------------------------------ */

/** store 里取出来的用户设置（服务端算日记日要用） */
export interface ServerSettings {
  timezone: string;
  dayStartHour: number;
}

export interface TodayMeta {
  /** 服务端权威的日记日（YYYY-MM-DD） */
  diary_date: ISODate;
  /** 日记日的前一天——"昨日回顾"写的就是这一行 */
  yesterday: ISODate;
  timezone: string;
  day_start_hour: number;
  server_time: string;
}

/**
 * 计算"今天"：日记日按用户时区与日界（默认 04:00）算，客户端不参与，
 * 避免客户端时区错误导致串天（计划 §4.5）。
 */
export function todayMeta(input: { now: Date; settings: ServerSettings }): TodayMeta {
  const diary = diaryDate(input.now, input.settings.timezone, input.settings.dayStartHour);
  return {
    diary_date: diary,
    yesterday: addDays(diary, -1),
    timezone: input.settings.timezone,
    day_start_hour: input.settings.dayStartHour,
    server_time: input.now.toISOString(),
  };
}

export const INCIDENT_TAGS = ['work', 'life', 'emotion', 'idea', 'other'] as const;
export type IncidentTag = (typeof INCIDENT_TAGS)[number];
export const MAX_INCIDENT_LENGTH = 2000;
export const DEFAULT_INCIDENT_TAG: IncidentTag = 'other';

export interface Incident {
  /** 客户端生成（重复提交天然幂等） */
  id: string;
  /** 归属日记日，由服务端按 occurred_at + 时区 + 日界算 */
  entryDate: ISODate;
  occurredAt: string;
  content: string;
  tag: string | null;
}

export function isIncidentTag(value: string): value is IncidentTag {
  return (INCIDENT_TAGS as readonly string[]).includes(value);
}

/**
 * 合理时间范围（2000-01-01 ~ 2100-01-01）。
 * 为什么要卡：极端的 occurred_at（如 0001-01-01 或 275760-09-13）在算日记日时会产出畸形日期
 * 或直接抛 RangeError，变成 500 并且会在数据库里留下脏数据。
 */
export const MIN_INSTANT = Date.UTC(2000, 0, 1);
export const MAX_INSTANT = Date.UTC(2100, 0, 1);

export function isReasonableInstant(iso: string): boolean {
  const parsed = Date.parse(iso);
  return !Number.isNaN(parsed) && parsed >= MIN_INSTANT && parsed <= MAX_INSTANT;
}

export interface IncidentInput {
  id: string;
  occurredAt: string;
  content: string;
  tag: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 校验并归一化一条突发事情：
 *  - `id` 由客户端生成（UUID）→ 重复提交天然幂等；
 *  - `content` 必填、去首尾空白、≤ 2000 字；
 *  - `occurred_at` 默认"现在"（由调用方传入），归属日稍后按它计算；
 *  - `tag` 留空 → DEFAULT_INCIDENT_TAG。
 */
export function normalizeIncidentInput(raw: {
  id?: unknown;
  content?: unknown;
  occurred_at?: unknown;
  tag?: unknown;
}, fallback: { now: Date }): IncidentInput {
  if (typeof raw?.id !== 'string' || !UUID_PATTERN.test(raw.id)) {
    throw new DiaryError('invalid_field', 'id 必须是客户端生成的 UUID');
  }

  if (typeof raw?.content !== 'string') {
    throw new DiaryError('invalid_field', 'content 必须是字符串');
  }
  const content = raw.content.trim();
  if (content === '') throw new DiaryError('invalid_field', 'content 不能为空');
  if (content.length > MAX_INCIDENT_LENGTH) {
    throw new DiaryError('too_long', `突发事情内容最多 ${MAX_INCIDENT_LENGTH} 个字符，收到 ${content.length}`);
  }

  let occurredAt = fallback.now;
  if (raw.occurred_at !== undefined && raw.occurred_at !== null && raw.occurred_at !== '') {
    if (typeof raw.occurred_at !== 'string') {
      throw new DiaryError('invalid_field', 'occurred_at 必须是 ISO 时间字符串');
    }
    const parsed = Date.parse(raw.occurred_at);
    if (Number.isNaN(parsed)) throw new DiaryError('invalid_field', `occurred_at 不是合法时间：${raw.occurred_at}`);
    // 极端的年份（0001 / +275760）会在算归属日时产出畸形日期或直接抛 RangeError → 在入口就挡掉
    if (parsed < MIN_INSTANT || parsed > MAX_INSTANT) {
      throw new DiaryError('invalid_field', 'occurred_at 必须在 2000–2100 年之间');
    }
    occurredAt = new Date(parsed);
  }

  let tag: string = DEFAULT_INCIDENT_TAG;
  if (raw.tag !== undefined && raw.tag !== null && raw.tag !== '') {
    if (typeof raw.tag !== 'string' || !isIncidentTag(raw.tag)) {
      throw new DiaryError('invalid_field', `tag 只能是 ${INCIDENT_TAGS.join(' / ')}`);
    }
    tag = raw.tag;
  }

  return { id: raw.id, content, occurredAt: occurredAt.toISOString(), tag };
}

/** 突发事情的归属日：按发生时间 + 用户时区 + 日界算（改时间跨日 → 归属日跟着变，计划 §5.4）。 */
export function incidentEntryDate(occurredAt: string, settings: ServerSettings): ISODate {
  return diaryDate(new Date(occurredAt), settings.timezone, settings.dayStartHour);
}

/* -------------------------------- 日历视图 -------------------------------- */

export interface CalendarDay {
  date: ISODate;
  /** 那天有没有任何正文（回顾/计划/总结任意一项非空） */
  hasContent: boolean;
  incidentCount: number;
}

export interface CalendarView {
  month: string;
  days: CalendarDay[];
}

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

/** '2026-09' → { start: '2026-09-01', end: '2026-10-01' }（左闭右开，跨年也对） */
export function monthRange(month: string): { start: ISODate; end: ISODate } {
  const match = MONTH_PATTERN.exec(month);
  if (!match) throw new DiaryError('invalid_field', `month 必须是 YYYY-MM 格式，收到：${month}`);
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12 || year < 1900 || year > 2200) {
    throw new DiaryError('invalid_field', `month 越界：${month}`);
  }
  const start = `${String(year).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}-01` as ISODate;
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const end = `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01` as ISODate;
  return { start, end };
}

export interface TodayView {
  meta: TodayMeta;
  today: DiaryEntry;
  yesterday: DiaryEntry;
  incidents: Incident[];
  progress: Progress;
}
