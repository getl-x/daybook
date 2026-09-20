import { useCallback, useEffect, useRef, useState } from 'react';
import { patchDiary, type DiaryFieldName } from './api.ts';
import { AutosaveController, type AutosaveOptions } from './autosave-controller.ts';
import { clearDraft, listDrafts, saveDraft } from './drafts.ts';

export type { SaveState } from './autosave-controller.ts';

/** 页面按 user/date 挂载表单；队列负责保存，hook 负责浏览器生命周期。 */
export function useAutosave(options: AutosaveOptions) {
  const [controller] = useState(
    () =>
      new AutosaveController(options, {
        patch: patchDiary,
        save: saveDraft,
        clear: clearDraft,
        list: listDrafts,
      }),
  );
  const [snapshot, setSnapshot] = useState(controller.snapshot);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => controller.flush(), [controller]);

  useEffect(() => controller.subscribe(setSnapshot), [controller]);
  useEffect(() => {
    void controller.initialize().then(flush);
    const onHide = () => {
      if (timer.current) clearTimeout(timer.current);
      void flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide();
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('online', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    const retry = setInterval(() => {
      if (controller.snapshot.state === 'offline') void flush();
    }, 20_000);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('online', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(retry);
      onHide();
    };
  }, [controller, flush]);

  const setValue = useCallback(
    (field: DiaryFieldName, value: string) => {
      controller.setValue(field, value);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void flush();
      }, 1500);
    },
    [controller, flush],
  );

  return {
    ...snapshot,
    setValue,
    flush,
    resolveDraft: (field: DiaryFieldName, useLocal: boolean) => controller.resolveDraft(field, useLocal),
    dismissConflicts: () => controller.dismissConflicts(),
  };
}
