import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';

import type { DiaryFieldName, DiaryFieldState } from '../lib/api.ts';
import { useAutosave, type SaveState } from '../lib/autosave.ts';
import { Banner, SaveStatusLine } from './ui.tsx';

export interface DiaryFieldSpec {
  field: DiaryFieldName;
  prompt: string;
}

export interface DiaryFormState {
  state: SaveState;
  savedAt: number | null;
  message: string | null;
  conflicts: DiaryFieldName[];
  hasRecovery: boolean;
  /** 当前输入内容：父组件要把它收成一行摘要时得用本地值，不能只看服务端返回的 */
  values: Record<DiaryFieldName, string>;
}

/** 给父组件的显式「保存」按钮用 */
export interface DiaryFormHandle {
  flush(): Promise<void>;
}

interface Props {
  userId: string;
  /** 这一组字段写进哪一天的记录（今日计划 / 晚间总结都写今天那一行） */
  entryDate: string;
  initialFields: Record<DiaryFieldName, DiaryFieldState>;
  fields: DiaryFieldSpec[];
  /** 状态回报给父组件（顶部汇总状态用） */
  onStateChange?(state: DiaryFormState): void;
  /** 是否在表单底部显示保存状态 */
  showStatus?: boolean;
  ref?: Ref<DiaryFormHandle>;
}

/**
 * 一组可编辑字段 + 自动保存 + 冲突提示。
 *
 * 今日页挂两个实例（今日计划 / 晚间总结），单日详情页挂一个（四个字段都能改）。
 */
export function DiaryForm({
  userId,
  entryDate,
  initialFields,
  fields,
  onStateChange,
  showStatus = true,
  ref,
}: Props) {
  const autosave = useAutosave({
    userId,
    entryDate,
    initialFields,
    fields: fields.map(({ field }) => field),
  });

  // 「保存」按钮直接复用自动保存的 flush：没有改动时它自己就返回了
  useImperativeHandle(ref, () => ({ flush: autosave.flush }), [autosave.flush]);

  // 用 ref 存回调：父组件传内联函数也不会引起重复触发
  const callbackRef = useRef(onStateChange);
  callbackRef.current = onStateChange;

  useEffect(() => {
    callbackRef.current?.({
      state: autosave.state,
      savedAt: autosave.savedAt,
      message: autosave.message,
      conflicts: autosave.conflicts,
      hasRecovery: Object.keys(autosave.recovery).length > 0,
      values: autosave.values,
    });
  }, [
    autosave.state,
    autosave.savedAt,
    autosave.message,
    autosave.conflicts,
    autosave.values,
    autosave.recovery,
  ]);

  return (
    <div className="space-y-4">
      {fields.map(({ field, prompt }) => (
        <div key={field} className="space-y-3">
          {autosave.recovery[field] ? (
            <Banner tone="warn">
              <p className="font-medium">本机有一份未同步的草稿</p>
              <p className="mt-1 text-xs">它与服务器版本不同，选择要保留的内容后继续书写。</p>
              <p className="draft-preview">{autosave.recovery[field]?.value || '（空白内容）'}</p>
              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  className="button-primary"
                  onClick={() => void autosave.resolveDraft(field, true)}
                >
                  恢复本机草稿
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => void autosave.resolveDraft(field, false)}
                >
                  保留服务器内容
                </button>
              </div>
            </Banner>
          ) : null}
          <label className="diary-field">
            <span className="field-label">{prompt}</span>
            <textarea
              disabled={!autosave.ready || !!autosave.recovery[field]}
              value={autosave.values[field]}
              onChange={(event) => autosave.setValue(field, event.target.value)}
              onBlur={() => void autosave.flush()}
              rows={4}
              placeholder={
                field === 'day_plan'
                  ? '今天，想把时间留给哪些事？'
                  : field === 'evening_summary'
                    ? '那些值得记住的小事，也算数。'
                    : '慢慢写，不必组织得很完美。'
              }
              className="diary-textarea"
            />
          </label>
        </div>
      ))}

      {autosave.conflicts.length > 0 ? (
        <Banner tone="warn" onDismiss={autosave.dismissConflicts}>
          另一台设备也修改过这条内容，本次已保存你刚刚提交的版本。
        </Banner>
      ) : null}

      {autosave.state === 'error' || autosave.state === 'offline' ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 text-sm text-amber-700 dark:text-amber-300"
        >
          <span>{autosave.message}</span>
          <button type="button" onClick={() => void autosave.flush()} className="underline">
            重试保存
          </button>
        </div>
      ) : null}

      {showStatus ? (
        <p className="text-right text-xs text-slate-400">
          <SaveStatusLine states={[autosave.state]} savedAt={autosave.savedAt} message={autosave.message} />
        </p>
      ) : null}
    </div>
  );
}
