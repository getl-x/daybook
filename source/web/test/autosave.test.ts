import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiError,
  DIARY_FIELDS,
  type DiaryFieldName,
  type DiaryFieldState,
  type PatchResponse,
} from '../src/lib/api.ts';
import { AutosaveController, type AutosaveDependencies } from '../src/lib/autosave-controller.ts';
import type { DraftRecord } from '../src/lib/drafts.ts';

const stamp = '2026-09-20T10:00:00.000Z';
const nextStamp = '2026-09-20T10:01:00.000Z';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  drafts: DraftRecord[] = [],
  override: Partial<AutosaveDependencies> = {},
  fields: readonly DiaryFieldName[] = DIARY_FIELDS,
) {
  const disk = new Map(drafts.map((d) => [d.field, d]));
  const sent: Parameters<AutosaveDependencies['patch']>[1][] = [];
  const deps: AutosaveDependencies = {
    list: async () => [...disk.values()],
    save: async (d) => {
      disk.set(d.field, { ...d, key: d.field });
    },
    clear: async (_u, _d, f, rev) => {
      if (disk.get(f)?.revision === rev) disk.delete(f);
    },
    patch: async (date, payload) => {
      sent.push(payload);
      return {
        entryDate: date,
        version: sent.length,
        fields: Object.fromEntries(
          Object.entries(payload).map(([f, p]) => [
            f,
            { value: p!.value.trimEnd(), updatedAt: nextStamp, overwritten: false },
          ]),
        ),
      };
    },
    ...override,
  };
  const controller = new AutosaveController(
    {
      userId: 'u',
      entryDate: '2026-09-20',
      fields,
      initialFields: Object.fromEntries(
        DIARY_FIELDS.map((f) => [f, { value: 'original', updatedAt: stamp }]),
      ) as Record<DiaryFieldName, DiaryFieldState>,
    },
    deps,
  );
  return { controller, disk, sent, deps };
}
function draft(extra: Partial<DraftRecord> = {}): DraftRecord {
  return {
    key: 'day_plan',
    userId: 'u',
    entryDate: '2026-09-20',
    field: 'day_plan',
    value: 'offline draft',
    modifiedAt: Date.parse(stamp) + 30000,
    baseUpdatedAt: stamp,
    revision: 'draft-1',
    ...extra,
  };
}

test('slow save preserves and drains newer input, including reverting to the original text', async () => {
  for (const latest of ['AB', 'original']) {
    const started = deferred<void>();
    const response = deferred<PatchResponse>();
    const f = fixture();
    const normal = f.deps.patch;
    let count = 0;
    f.deps.patch = async (date, payload) => {
      if (++count === 1) {
        f.sent.push(payload);
        started.resolve();
        return response.promise;
      }
      return normal(date, payload);
    };
    await f.controller.initialize();
    f.controller.setValue('day_plan', 'A');
    const saving = f.controller.flush();
    await started.promise;
    f.controller.setValue('day_plan', latest);
    assert.equal(f.controller.flush(), saving);
    response.resolve({
      entryDate: '2026-09-20',
      version: 1,
      fields: { day_plan: { value: 'A', updatedAt: nextStamp, overwritten: false } },
    });
    await saving;
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[1]?.day_plan?.value, latest);
    assert.equal(f.sent[1]?.day_plan?.base_updated_at, nextStamp);
    assert.equal(f.controller.snapshot.values.day_plan, latest);
    assert.equal(f.controller.snapshot.state, 'saved');
    assert.equal(f.disk.size, 0);
  }
});

test('new draft within 30 seconds of the server save is replayed, regardless of clock skew', async () => {
  for (const modifiedAt of [Date.parse(stamp) + 30000, 1]) {
    const f = fixture([draft({ modifiedAt })]);
    await f.controller.flush();
    assert.equal(f.sent[0]?.day_plan?.value, 'offline draft');
    assert.equal(f.disk.size, 0);
  }
});

test('legacy and conflicting drafts are preserved until the user explicitly chooses', async () => {
  for (const baseUpdatedAt of [undefined, 'older-version']) {
    const f = fixture([draft({ baseUpdatedAt })]);
    await f.controller.flush();
    assert.equal(f.sent.length, 0);
    assert.equal(f.disk.size, 1);
    assert.equal(f.controller.snapshot.recovery.day_plan?.value, 'offline draft');
    await f.controller.resolveDraft('day_plan', true);
    assert.equal(f.sent[0]?.day_plan?.value, 'offline draft');
    assert.equal(f.disk.size, 0);
  }
});

test('choosing server content clears only the conflicting draft without a network write', async () => {
  const f = fixture([draft({ baseUpdatedAt: 'older' })]);
  await f.controller.initialize();
  await f.controller.resolveDraft('day_plan', false);
  assert.equal(f.disk.size, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.controller.snapshot.values.day_plan, 'original');
});

test('separate morning and evening forms only restore their own fields', async () => {
  const f = fixture([draft(), draft({ field: 'evening_summary' })], {}, ['day_plan']);
  await f.controller.flush();
  assert.equal(f.sent[0]?.evening_summary, undefined);
  assert.equal(f.disk.has('evening_summary'), true);
});

test('network errors retain the draft and retry succeeds', async () => {
  const f = fixture();
  const normal = f.deps.patch;
  f.deps.patch = async () => {
    throw new TypeError('offline');
  };
  await f.controller.initialize();
  f.controller.setValue('day_plan', 'keep me');
  await f.controller.flush();
  assert.equal(f.controller.snapshot.state, 'offline');
  assert.equal(f.disk.get('day_plan')?.value, 'keep me');
  f.deps.patch = normal;
  await f.controller.flush();
  assert.equal(f.controller.snapshot.state, 'saved');
});

test('storage failure does not pretend the draft is safely saved or send the request', async () => {
  const f = fixture([], {
    save: async () => {
      throw new Error('quota');
    },
  });
  await f.controller.initialize();
  f.controller.setValue('day_plan', 'keep the page open');
  await f.controller.flush();
  assert.equal(f.controller.snapshot.state, 'error');
  assert.match(f.controller.snapshot.message!, /本机草稿/);
  assert.equal(f.sent.length, 0);
});

test('validation failures are not mislabeled as offline', async () => {
  const f = fixture([], {
    patch: async () => {
      throw new ApiError(400, 'too_long');
    },
  });
  await f.controller.initialize();
  f.controller.setValue('day_plan', 'long');
  await f.controller.flush();
  assert.equal(f.controller.snapshot.state, 'error');
  assert.match(f.controller.snapshot.message!, /长度/);
  assert.equal(f.disk.size, 1);
});

test('an edit arriving while draft deletion commits still gets sent', async () => {
  const f = fixture();
  const clear = f.deps.clear;
  let once = false;
  f.deps.clear = async (...args) => {
    if (!once) {
      once = true;
      f.controller.setValue('day_plan', 'newer');
    }
    await clear(...args);
  };
  await f.controller.initialize();
  f.controller.setValue('day_plan', 'first');
  await f.controller.flush();
  assert.equal(f.sent.at(-1)?.day_plan?.value, 'newer');
  assert.equal(f.controller.snapshot.state, 'saved');
});
