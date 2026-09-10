import { useEffect, useRef } from 'react';

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
}

interface Props {
  userId: string;
  /** 这一组字段写进哪一天的记录（昨日回顾写昨天那一行） */
  entryDate: string;
  initialFields: Record<DiaryFieldName, DiaryFieldState>;
  fields: DiaryFieldSpec[];
  /** 状态回报给父组件（顶部汇总状态用） */
  onStateChange?(state: DiaryFormState): void;
  /** 是否在表单底部显示保存状态 */
  showStatus?: boolean;
}

/**
 * 一组可编辑字段 + 自动保存 + 冲突提示。
 *
 * 今日页会挂两个实例（昨天那一行 / 今天那一行）；单日详情页挂一个（四个字段都能改）。
 */
export function DiaryForm({ userId, entryDate, initialFields, fields, onStateChange, showStatus = true }: Props) {
  const autosave = useAutosave({ userId, entryDate, initialFields });

  // 用 ref 存回调：父组件传内联函数也不会引起重复触发
  const callbackRef = useRef(onStateChange);
  callbackRef.current = onStateChange;

  useEffect(() => {
    callbackRef.current?.({
      state: autosave.state,
      savedAt: autosave.savedAt,
      message: autosave.message,
      conflicts: autosave.conflicts,
    });
  }, [autosave.state, autosave.savedAt, autosave.message, autosave.conflicts]);

  return (
    <div className="space-y-4">
      {fields.map(({ field, prompt }) => (
        <label key={field} className="block space-y-1.5">
          <span className="text-sm text-slate-500 dark:text-slate-400">{prompt}</span>
          <textarea
            value={autosave.values[field]}
            onChange={(event) => autosave.setValue(field, event.target.value)}
            onBlur={() => void autosave.flush()}
            rows={3}
            className="w-full resize-y rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-900 outline-none transition focus:border-slate-900 focus:bg-white dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-300"
          />
        </label>
      ))}

      {autosave.conflicts.length > 0 ? (
        <Banner tone="warn" onDismiss={autosave.dismissConflicts}>
          这条内容在另一台设备上更新过，已采用最新版本（本地输入仍在草稿里）。
        </Banner>
      ) : null}

      {showStatus ? (
        <p className="text-right text-xs text-slate-400">
          <SaveStatusLine states={[autosave.state]} savedAt={autosave.savedAt} message={autosave.message} />
        </p>
      ) : null}
    </div>
  );
}
