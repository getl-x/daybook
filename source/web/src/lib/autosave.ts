/**
 * 自动保存 hook：把"输入 → 落库"收在一处。
 *
 * 规则（计划 §9.2）：
 *  - 停止输入 1.5 秒防抖；失焦、pagehide、切到后台时立即提交；
 *  - **只提交变更字段**，并且跳过"内容没变"的字段；
 *  - 每个字段带 `base_updated_at`；服务端回 `overwritten: true` 时交给界面提示；
 *  - 发送前**先把草稿写进 IndexedDB**，发送成功再清掉——页面被杀/断网都不丢字；
 *  - 请求在途时**不并发提交**，但也不丢字：先把草稿落盘，再排队补一次 flush；
 *  - 失败标 offline 并自动重试（`online` 事件 + 定时探测）；
 *  - 重放旧草稿前先比时间：服务器上的内容更新就丢弃草稿，避免旧草稿盖掉新内容。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiError,
  DIARY_FIELDS,
  patchDiary,
  type DiaryFieldName,
  type DiaryFieldState,
  type FieldPatchResult,
} from './api.ts';
import { clearDraft, listDrafts, saveDraft } from './drafts.ts';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'offline' | 'error';

const DEBOUNCE_MS = 1500;
const RETRY_MS = 20_000;
/**
 * 判定"服务器内容更新"时容忍的时钟偏差：客户端与服务端的时钟不可能完全一致，
 * 只有草稿明显早于服务器写入时间才算过期草稿。
 */
const DRAFT_SKEW_MS = 2 * 60 * 1000;

export interface UseAutosaveOptions {
  userId: string;
  /** 这一行记录的日期（昨日回顾写的是昨天那一行） */
  entryDate: string;
  initialFields: Record<DiaryFieldName, DiaryFieldState>;
}

export interface AutosaveApi {
  values: Record<DiaryFieldName, string>;
  state: SaveState;
  savedAt: number | null;
  message: string | null;
  conflicts: DiaryFieldName[];
  setValue(field: DiaryFieldName, value: string): void;
  /** 立即提交（失焦、切换页面时调） */
  flush(): Promise<void>;
  dismissConflicts(): void;
}

function toValues(fields: Record<DiaryFieldName, DiaryFieldState>): Record<DiaryFieldName, string> {
  const values = {} as Record<DiaryFieldName, string>;
  for (const field of DIARY_FIELDS) values[field] = fields[field]?.value ?? '';
  return values;
}

export function useAutosave({ userId, entryDate, initialFields }: UseAutosaveOptions): AutosaveApi {
  const initialValues = toValues(initialFields);
  const [values, setValues] = useState<Record<DiaryFieldName, string>>(initialValues);
  const [state, setState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<DiaryFieldName[]>([]);

  const valuesRef = useRef(initialValues);
  /** 服务端最后确认的每字段 updatedAt（下次提交当基准） */
  const baselineRef = useRef<Record<DiaryFieldName, string | null>>(
    Object.fromEntries(DIARY_FIELDS.map((field) => [field, initialFields[field]?.updatedAt ?? null])) as Record<
      DiaryFieldName,
      string | null
    >,
  );
  /** 服务端最后确认的值（用来跳过"没变"的提交） */
  const lastSentRef = useRef<Record<DiaryFieldName, string>>(initialValues);
  const dirtyRef = useRef<Set<DiaryFieldName>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  /** 请求在途时又来了 flush：结束后立刻再跑一次，避免这段输入被吞掉 */
  const pendingRef = useRef(false);

  const flush = useCallback(async (): Promise<void> => {
    const dirty = [...dirtyRef.current];
    if (dirty.length === 0) return;

    // 1) 先落草稿：请求在途、失败、页面被杀都还在（这一步必须在"在途"判断之前）
    await Promise.all(
      dirty.map((field) =>
        saveDraft({
          userId,
          entryDate,
          field,
          value: valuesRef.current[field],
          modifiedAt: Date.now(),
        }),
      ),
    );

    // 2) 在途时不并发提交，但排队补一次
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }

    // 3) 组装真正需要提交的字段
    const payload: Partial<Record<DiaryFieldName, { value: string; base_updated_at: string | null }>> = {};
    for (const field of dirty) {
      if (valuesRef.current[field] === lastSentRef.current[field]) {
        dirtyRef.current.delete(field);
        await clearDraft(userId, entryDate, field);
        continue;
      }
      payload[field] = { value: valuesRef.current[field], base_updated_at: baselineRef.current[field] };
    }
    if (Object.keys(payload).length === 0) {
      setState('saved');
      return;
    }

    inFlightRef.current = true;
    setState('saving');
    try {
      const result = await patchDiary(entryDate, payload);
      const overwritten: DiaryFieldName[] = [];
      for (const [field, info] of Object.entries(result.fields) as [DiaryFieldName, FieldPatchResult][]) {
        baselineRef.current[field] = info.updatedAt;
        lastSentRef.current[field] = info.value;
        dirtyRef.current.delete(field);
        if (info.overwritten) overwritten.push(field);
        await clearDraft(userId, entryDate, field);
      }
      if (overwritten.length > 0) {
        setConflicts((previous) => [...new Set([...previous, ...overwritten])]);
      }
      setSavedAt(Date.now());
      setState('saved');
      setMessage(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setState('error');
        setMessage('登录已过期，请重新登录');
      } else {
        setState('offline');
        setMessage('暂时连不上服务，已存在本机草稿，恢复后会自动同步');
      }
    } finally {
      inFlightRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        // 期间新输入的内容再走一轮（草稿已经在上面落过盘了）
        void flush();
      }
    }
  }, [entryDate, userId]);

  const setValue = useCallback(
    (field: DiaryFieldName, value: string): void => {
      valuesRef.current = { ...valuesRef.current, [field]: value };
      setValues(valuesRef.current);
      if (value === lastSentRef.current[field]) {
        dirtyRef.current.delete(field);
        return;
      }
      dirtyRef.current.add(field);
      setState('dirty');
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flush();
      }, DEBOUNCE_MS);
    },
    [flush],
  );

  // 页面被隐藏 / 关闭时立刻提交（草稿已在 flush 里先落盘）
  useEffect(() => {
    const onHide = (): void => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      void flush();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') onHide();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      onHide();
    };
  }, [flush]);

  // 网络恢复 → 立刻重放；否则每 20 秒试一次
  useEffect(() => {
    const onOnline = (): void => {
      void flush();
    };
    window.addEventListener('online', onOnline);
    const interval = setInterval(() => {
      if (dirtyRef.current.size > 0) void flush();
    }, RETRY_MS);
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(interval);
    };
  }, [flush]);

  // 上次没同步完的草稿：进页面就补上并重放
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const drafts = (await listDrafts(userId)).filter((draft) => draft.entryDate === entryDate);
      if (cancelled || drafts.length === 0) return;

      const restored = { ...valuesRef.current };
      let replay = 0;
      let stale = 0;

      for (const draft of drafts) {
        if (!(DIARY_FIELDS as readonly string[]).includes(draft.field)) continue;
        const field = draft.field as DiaryFieldName;
        const serverValue = lastSentRef.current[field] ?? '';
        const serverAt = baselineRef.current[field] ? Date.parse(baselineRef.current[field] as string) : 0;

        // 内容一致 → 没什么可补的
        if (draft.value.trimEnd() === serverValue.trimEnd()) {
          await clearDraft(userId, entryDate, field);
          continue;
        }
        // 服务器上的内容明显更新 → 旧草稿会盖掉新内容，直接丢弃并告知用户
        if (serverAt > 0 && draft.modifiedAt <= serverAt + DRAFT_SKEW_MS) {
          await clearDraft(userId, entryDate, field);
          stale += 1;
          continue;
        }

        restored[field] = draft.value;
        dirtyRef.current.add(field);
        replay += 1;
      }

      if (cancelled) return;

      if (replay > 0) {
        valuesRef.current = restored;
        setValues(restored);
        setState('dirty');
        setMessage('本地有未同步的草稿，正在补传…');
        await flush();
        return;
      }
      if (stale > 0) {
        setMessage('本机有旧草稿，但服务器上的内容更新，已保留服务器版本');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entryDate, userId, flush]);

  const dismissConflicts = useCallback(() => setConflicts([]), []);

  return { values, state, savedAt, message, conflicts, setValue, flush, dismissConflicts };
}
