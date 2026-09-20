import {
  ApiError,
  DIARY_FIELDS,
  type DiaryFieldName,
  type DiaryFieldState,
  type PatchResponse,
} from './api.ts';
import type { DraftRecord } from './drafts.ts';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'offline' | 'error';
type Values = Record<DiaryFieldName, string>;
type Patch = Partial<Record<DiaryFieldName, { value: string; base_updated_at: string | null }>>;
type Draft = Omit<DraftRecord, 'key'>;

export interface AutosaveSnapshot {
  ready: boolean;
  values: Values;
  state: SaveState;
  savedAt: number | null;
  message: string | null;
  conflicts: DiaryFieldName[];
  recovery: Partial<Record<DiaryFieldName, DraftRecord>>;
}

export interface AutosaveOptions {
  userId: string;
  entryDate: string;
  initialFields: Record<DiaryFieldName, DiaryFieldState>;
  fields?: readonly DiaryFieldName[];
}

export interface AutosaveDependencies {
  save(draft: Draft): Promise<void>;
  clear(user: string, date: string, field: string, revision?: string): Promise<void>;
  list(user: string): Promise<DraftRecord[]>;
  patch(date: string, payload: Patch): Promise<PatchResponse>;
}

/** 每次输入独立版本，网络确认只能清除该版本。与 React 分离以测试慢网和恢复场景。 */
export class AutosaveController {
  snapshot: AutosaveSnapshot;
  private options: AutosaveOptions;
  private deps: AutosaveDependencies;
  private baseline: Record<DiaryFieldName, string | null>;
  private confirmed: Values;
  private dirty = new Map<DiaryFieldName, Draft>();
  private listeners = new Set<(snapshot: AutosaveSnapshot) => void>();
  private writes: Promise<void> = Promise.resolve();
  private running: Promise<void> | null = null;
  private initialized: Promise<void> | null = null;
  private allowed: readonly DiaryFieldName[];

  constructor(options: AutosaveOptions, deps: AutosaveDependencies) {
    this.options = options;
    this.deps = deps;
    this.allowed = options.fields ?? DIARY_FIELDS;
    const values = Object.fromEntries(
      DIARY_FIELDS.map((f) => [f, options.initialFields[f]?.value ?? '']),
    ) as Values;
    this.baseline = Object.fromEntries(
      DIARY_FIELDS.map((f) => [f, options.initialFields[f]?.updatedAt ?? null]),
    ) as typeof this.baseline;
    this.confirmed = { ...values };
    this.snapshot = {
      ready: false,
      values,
      state: 'idle',
      savedAt: null,
      message: null,
      conflicts: [],
      recovery: {},
    };
  }

  subscribe(listener: (snapshot: AutosaveSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private update(change: Partial<AutosaveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  private storageError(): void {
    this.update({ state: 'error', message: '无法保存本机草稿，请保留此页面并检查浏览器存储权限。' });
  }

  private persist(draft: Draft): Promise<void> {
    const write = this.writes.then(() => {
      if (this.dirty.get(draft.field as DiaryFieldName)?.revision === draft.revision)
        return this.deps.save(draft);
    });
    this.writes = write.catch(() => {
      this.storageError();
    });
    return write;
  }

  setValue(field: DiaryFieldName, value: string): void {
    if (!this.snapshot.ready || !this.allowed.includes(field) || this.snapshot.recovery[field]) return;
    if (value === this.snapshot.values[field]) return;
    const draft: Draft = {
      userId: this.options.userId,
      entryDate: this.options.entryDate,
      field,
      value,
      modifiedAt: Date.now(),
      baseUpdatedAt: this.baseline[field],
      revision: crypto.randomUUID(),
    };
    this.dirty.set(field, draft);
    this.update({ values: { ...this.snapshot.values, [field]: value }, state: 'dirty', message: null });
    void this.persist(draft).catch(() => undefined);
  }

  initialize(): Promise<void> {
    if (!this.initialized) this.initialized = this.restore();
    return this.initialized;
  }

  private async restore(): Promise<void> {
    try {
      const drafts = await this.deps.list(this.options.userId);
      for (const draft of drafts) {
        const field = draft.field as DiaryFieldName;
        if (
          draft.entryDate !== this.options.entryDate ||
          !this.allowed.includes(field) ||
          this.dirty.has(field)
        )
          continue;
        if (draft.value === this.confirmed[field]) {
          await this.deps.clear(draft.userId, draft.entryDate, field, draft.revision);
          continue;
        }
        // 依据服务端版本，而不是两台设备可能偏差很大的时钟。未知版本也保留。
        if (draft.baseUpdatedAt === undefined || draft.baseUpdatedAt !== this.baseline[field]) {
          this.update({ recovery: { ...this.snapshot.recovery, [field]: draft } });
          continue;
        }
        this.dirty.set(field, draft);
        this.update({ values: { ...this.snapshot.values, [field]: draft.value }, state: 'dirty' });
      }
      this.update({ ready: true });
    } catch {
      this.storageError();
      this.initialized = null;
    }
  }

  async resolveDraft(field: DiaryFieldName, useLocal: boolean): Promise<void> {
    const draft = this.snapshot.recovery[field];
    if (!draft) return;
    if (!useLocal) {
      try {
        await this.deps.clear(draft.userId, draft.entryDate, field, draft.revision);
      } catch {
        this.storageError();
        return;
      }
    }
    const recovery = { ...this.snapshot.recovery };
    delete recovery[field];
    this.update({ recovery });
    if (useLocal) {
      this.setValue(field, draft.value);
      await this.flush();
    }
  }

  dismissConflicts(): void {
    this.update({ conflicts: [] });
  }

  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<void> {
    await this.initialize();
    while (this.dirty.size > 0) {
      const batch = [...this.dirty.entries()];
      const payload: Patch = {};
      try {
        for (const [, draft] of batch) await this.persist(draft);
      } catch {
        return;
      }
      for (const [field, draft] of batch) {
        payload[field] = { value: draft.value, base_updated_at: this.baseline[field] };
      }
      this.update({ state: 'saving' });
      let result: PatchResponse;
      try {
        result = await this.deps.patch(this.options.entryDate, payload);
      } catch (error) {
        const permanent =
          error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429;
        this.update({
          state: permanent ? 'error' : 'offline',
          message: permanent ? (error as Error).message : '暂时连不上服务，草稿已保存在本机，联网后会重试。',
        });
        return;
      }
      for (const [field, draft] of batch) {
        const info = result.fields[field];
        if (!info) {
          this.update({ state: 'error', message: '服务未确认全部内容，草稿已保留，请重试。' });
          return;
        }
        this.baseline[field] = info.updatedAt;
        this.confirmed[field] = info.value;
        if (info.overwritten) this.update({ conflicts: [...new Set([...this.snapshot.conflicts, field])] });
        if (this.dirty.get(field)?.revision !== draft.revision) {
          const next = { ...this.dirty.get(field)!, baseUpdatedAt: info.updatedAt };
          this.dirty.set(field, next);
          try {
            await this.persist(next);
          } catch {
            return;
          }
          continue;
        }
        try {
          await this.deps.clear(this.options.userId, this.options.entryDate, field, draft.revision);
        } catch {
          this.storageError();
          return;
        }
        if (this.dirty.get(field)?.revision === draft.revision) {
          this.dirty.delete(field);
          this.update({ values: { ...this.snapshot.values, [field]: info.value } });
        }
      }
      this.update({ savedAt: Date.now(), state: this.dirty.size ? 'dirty' : 'saved', message: null });
    }
  }
}
