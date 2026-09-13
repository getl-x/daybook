/**
 * 日记领域纯逻辑测试（不碰数据库）：字段校验、冲突判定、进度派生、日记日元信息。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_INCIDENT_TAG,
  DiaryError,
  INCIDENT_TAGS,
  MAX_TEXT_LENGTH,
  computeProgress,
  emptyEntry,
  isDiaryTextField,
  isIncidentTag,
  isOverwritten,
  normalizeBaseUpdatedAt,
  normalizeFieldValue,
  todayMeta,
  type DiaryEntry,
} from '../src/diary.ts';

describe('字段白名单与空记录', () => {
  it('只认四个正文字段', () => {
    for (const field of ['day_events', 'day_meals', 'day_plan', 'evening_summary']) {
      assert.equal(isDiaryTextField(field), true);
    }
    for (const field of ['day_events_updated_at', 'id', 'version', '__proto__', '']) {
      assert.equal(isDiaryTextField(field), false, `不该接受 ${field}`);
    }
  });

  it('emptyEntry 四个字段都是 null、version 0、exists false', () => {
    const entry = emptyEntry('2026-09-10');
    assert.equal(entry.exists, false);
    assert.equal(entry.version, 0);
    assert.deepEqual(entry.fields.day_plan, { value: null, updatedAt: null });
    assert.equal(entry.entryDate, '2026-09-10');
  });
});

describe('normalizeFieldValue', () => {
  it('去掉行尾空白，允许空串（= 清空）', () => {
    assert.equal(normalizeFieldValue('day_plan', '  今天写方案  \n'), '  今天写方案');
    assert.equal(normalizeFieldValue('day_plan', ''), '');
  });

  it('非字符串直接报错', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      assert.throws(() => normalizeFieldValue('day_plan', bad), DiaryError, `应拒绝 ${String(bad)}`);
    }
  });

  it('超长报 too_long', () => {
    assert.equal(normalizeFieldValue('day_plan', 'x'.repeat(MAX_TEXT_LENGTH)).length, MAX_TEXT_LENGTH);
    assert.throws(
      () => normalizeFieldValue('day_plan', 'x'.repeat(MAX_TEXT_LENGTH + 1)),
      (error: unknown) => error instanceof DiaryError && error.code === 'too_long',
    );
  });
});

describe('normalizeBaseUpdatedAt', () => {
  it('null / undefined → null', () => {
    assert.equal(normalizeBaseUpdatedAt(null), null);
    assert.equal(normalizeBaseUpdatedAt(undefined), null);
  });

  it('合法时间统一成 ISO', () => {
    assert.equal(normalizeBaseUpdatedAt('2026-09-10T01:02:03Z'), '2026-09-10T01:02:03.000Z');
    assert.equal(normalizeBaseUpdatedAt('2026-09-10T09:02:03+08:00'), '2026-09-10T01:02:03.000Z');
  });

  it('非法值报 invalid_base_updated_at', () => {
    for (const bad of ['昨天', '2026-13-45', 123, {}]) {
      assert.throws(
        () => normalizeBaseUpdatedAt(bad),
        (error: unknown) => error instanceof DiaryError && error.code === 'invalid_base_updated_at',
      );
    }
  });
});

describe('isOverwritten：字段级冲突判定', () => {
  const older = '2026-09-10T00:00:00.000Z';
  const newer = '2026-09-10T02:00:00.000Z';

  it('没带基准 / 服务端还没值 → 不算冲突', () => {
    assert.equal(isOverwritten(null, newer), false);
    assert.equal(isOverwritten(older, null), false);
    assert.equal(isOverwritten(null, null), false);
  });

  it('服务端比基准新 → 冲突；相等或更旧 → 不冲突', () => {
    assert.equal(isOverwritten(older, newer), true);
    assert.equal(isOverwritten(newer, newer), false);
    assert.equal(isOverwritten(newer, older), false);
  });

  it('时间格式坏掉时不误报冲突', () => {
    assert.equal(isOverwritten('不是时间', newer), false);
    assert.equal(isOverwritten(older, '也不是时间'), false);
  });
});

describe('computeProgress：进度是派生的', () => {
  const withFields = (values: Partial<Record<keyof DiaryEntry['fields'], string>>): DiaryEntry => {
    const entry = emptyEntry('2026-09-10');
    for (const [field, value] of Object.entries(values)) {
      entry.fields[field as keyof DiaryEntry['fields']] = { value: value as string, updatedAt: '2026-09-10T00:00:00.000Z' };
    }
    return entry;
  };

  it('早间完成只看今天的计划写没写', () => {
    assert.deepEqual(computeProgress(withFields({ day_plan: '写方案' })), { morningDone: true, eveningDone: false });
    assert.equal(computeProgress(withFields({})).morningDone, false);
    // 昨天的回顾字段不再参与早间完成判定（早间记录里已经没有"昨日回顾"）
    assert.equal(computeProgress(withFields({ day_events: '开会' })).morningDone, false);
    assert.equal(computeProgress(withFields({ day_meals: '面' })).morningDone, false);
  });

  it('只有空白字符不算写过', () => {
    assert.deepEqual(computeProgress(withFields({ day_plan: '   ' })), { morningDone: false, eveningDone: false });
  });

  it('晚间完成只看今天的总结', () => {
    assert.equal(computeProgress(withFields({ evening_summary: '还行' })).eveningDone, true);
  });
});

describe('todayMeta：日记日由服务端算', () => {
  it('04:00 之前算前一天，yesterday 跟着退一天', () => {
    // 上海本地 2026-09-10 03:00 → 仍属 09-09
    const meta = todayMeta({
      now: new Date('2026-09-09T19:00:00Z'),
      settings: { timezone: 'Asia/Shanghai', dayStartHour: 4 },
    });
    assert.equal(meta.diary_date, '2026-09-09');
    assert.equal(meta.yesterday, '2026-09-08');
    assert.equal(meta.timezone, 'Asia/Shanghai');
    assert.equal(meta.day_start_hour, 4);
    assert.equal(meta.server_time, '2026-09-09T19:00:00.000Z');
  });

  it('04:00 之后是当天', () => {
    const meta = todayMeta({
      now: new Date('2026-09-09T20:00:00Z'),
      settings: { timezone: 'Asia/Shanghai', dayStartHour: 4 },
    });
    assert.equal(meta.diary_date, '2026-09-10');
    assert.equal(meta.yesterday, '2026-09-09');
  });

  it('跨月边界也对（月初的 yesterday 落到上月最后一天）', () => {
    const meta = todayMeta({
      now: new Date('2026-09-30T20:00:00Z'), // 上海 10-01 04:00
      settings: { timezone: 'Asia/Shanghai', dayStartHour: 4 },
    });
    assert.equal(meta.diary_date, '2026-10-01');
    assert.equal(meta.yesterday, '2026-09-30');
  });
});

describe('突发事情标签', () => {
  it('白名单与默认值', () => {
    for (const tag of INCIDENT_TAGS) assert.equal(isIncidentTag(tag), true);
    assert.equal(isIncidentTag('work'), true);
    assert.equal(isIncidentTag('whatever'), false);
    assert.equal(isIncidentTag(''), false);
    assert.equal(DEFAULT_INCIDENT_TAG, 'other');
  });
});
