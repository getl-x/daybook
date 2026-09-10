/**
 * 阶段 0 spike ② 的验收测试：日记日边界、时区、DST、以及提醒时刻的推进。
 * 用 Node 内置 runner（node --test）跑，不需要任何依赖：
 *   node --test "shared/test/*.test.ts"
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays,
  diaryDate,
  nextFireAt,
  resolveLocal,
  wallClock,
  zoneOffsetMinutes,
} from '../src/time.ts';

const at = (iso: string): Date => new Date(iso);
const isoOf = (instant: Date): string => instant.toISOString();

const SHANGHAI = 'Asia/Shanghai';
const NEW_YORK = 'America/New_York';
const LONDON = 'Europe/London';
const KOLKATA = 'Asia/Kolkata';
const TOKYO = 'Asia/Tokyo';

describe('diaryDate：日界（默认 04:00 起算）', () => {
  it('04:00 之前算前一天，04:00 起算新的一天', () => {
    // 本地 2026-09-10 03:59:59（UTC+8）
    assert.equal(diaryDate(at('2026-09-09T19:59:59Z'), SHANGHAI), '2026-09-09');
    // 本地 2026-09-10 04:00:00
    assert.equal(diaryDate(at('2026-09-09T20:00:00Z'), SHANGHAI), '2026-09-10');
  });

  it('覆盖 00:00 与 23:59 两个自然日边界', () => {
    // 本地 2026-09-10 00:00 —— 属于前一个日记日
    assert.equal(diaryDate(at('2026-09-09T16:00:00Z'), SHANGHAI), '2026-09-09');
    // 本地 2026-09-10 23:59:59 —— 仍属于当天
    assert.equal(diaryDate(at('2026-09-10T15:59:59Z'), SHANGHAI), '2026-09-10');
  });

  it('同一瞬间在不同时区得到不同日记日', () => {
    // 同一瞬间：上海 09-10 04:00 / 纽约 09-09 16:00 / 加尔各答 09-10 01:30 / 东京 09-10 05:00
    const instant = at('2026-09-09T20:00:00Z');
    assert.equal(diaryDate(instant, SHANGHAI), '2026-09-10');
    assert.equal(diaryDate(instant, NEW_YORK), '2026-09-09');
    assert.equal(diaryDate(instant, KOLKATA), '2026-09-09'); // 01:30 < 04:00
    assert.equal(diaryDate(instant, TOKYO), '2026-09-10');
  });

  it('dayStartHour=0 时退化为自然日', () => {
    assert.equal(diaryDate(at('2026-09-09T16:00:00Z'), SHANGHAI, 0), '2026-09-10');
  });

  it('DST 春季跳变当天：日界仍按墙上时间判断', () => {
    // 纽约 2026-03-08 01:30 EST 与 03:30 EDT 都在 04:00 之前 → 仍属 03-07
    assert.equal(diaryDate(at('2026-03-08T06:30:00Z'), NEW_YORK), '2026-03-07');
    assert.equal(diaryDate(at('2026-03-08T07:30:00Z'), NEW_YORK), '2026-03-07');
    // 纽约 2026-03-08 04:00 EDT → 新日记日开始
    assert.equal(diaryDate(at('2026-03-08T08:00:00Z'), NEW_YORK), '2026-03-08');
  });

  it('DST 秋季回拨当天：第一次出现的时刻仍属当天', () => {
    // 纽约 2026-11-01 01:30 EDT（第一次出现）→ 属 10-31
    assert.equal(diaryDate(at('2026-11-01T05:30:00Z'), NEW_YORK), '2026-10-31');
  });

  it('拒绝非法入参', () => {
    assert.throws(() => diaryDate(at('2026-09-10T00:00:00Z'), 'Not/AZone'));
    assert.throws(() => diaryDate(at('2026-09-10T00:00:00Z'), SHANGHAI, 7));
    assert.throws(() => diaryDate(at('2026-09-10T00:00:00Z'), SHANGHAI, 1.5));
  });
});

describe('addDays：纯日历运算', () => {
  it('跨月、跨年、闰年都正确', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2027-01-01', -1), '2026-12-31');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2028-03-01', -1), '2028-02-29'); // 闰年
    assert.equal(addDays('2026-09-10', 0), '2026-09-10');
  });
});

describe('zoneOffsetMinutes / wallClock', () => {
  it('返回正确的时区偏移', () => {
    assert.equal(zoneOffsetMinutes(at('2026-07-01T00:00:00Z'), SHANGHAI), 480);
    assert.equal(zoneOffsetMinutes(at('2026-07-01T00:00:00Z'), KOLKATA), 330);
    assert.equal(zoneOffsetMinutes(at('2026-01-01T00:00:00Z'), NEW_YORK), -300); // EST
    assert.equal(zoneOffsetMinutes(at('2026-07-01T00:00:00Z'), NEW_YORK), -240); // EDT
    assert.equal(zoneOffsetMinutes(at('2026-07-01T00:00:00Z'), LONDON), 60); // BST
  });

  it('午夜不会输出 24 点', () => {
    const wall = wallClock(at('2026-09-09T16:00:00Z'), SHANGHAI);
    assert.deepEqual(wall, { year: 2026, month: 9, day: 10, hour: 0, minute: 0, second: 0 });
  });
});

describe('resolveLocal：DST 安全地解析墙上时间', () => {
  it('普通时刻唯一解', () => {
    assert.equal(isoOf(resolveLocal('2026-09-10', '09:00', SHANGHAI)), '2026-09-10T01:00:00.000Z');
    assert.equal(isoOf(resolveLocal('2026-09-10', '09:00', KOLKATA)), '2026-09-10T03:30:00.000Z');
  });

  it('春季跳变（该墙上时间不存在）→ 顺延一个跳变间隔', () => {
    // 纽约 2026-03-08 02:00 EST → 03:00 EDT，02:30 不存在 → 结果是 03:30 EDT
    assert.equal(isoOf(resolveLocal('2026-03-08', '02:30', NEW_YORK)), '2026-03-08T07:30:00.000Z');
    // 伦敦 2026-03-29 01:00 GMT → 02:00 BST，01:30 不存在 → 结果是 02:30 BST
    assert.equal(isoOf(resolveLocal('2026-03-29', '01:30', LONDON)), '2026-03-29T01:30:00.000Z');
  });

  it('秋季回拨（该墙上时间出现两次）→ 取较早的一次', () => {
    // 纽约 2026-11-01 01:30 出现两次：05:30Z（EDT）与 06:30Z（EST）→ 取 05:30Z
    assert.equal(isoOf(resolveLocal('2026-11-01', '01:30', NEW_YORK)), '2026-11-01T05:30:00.000Z');
  });
});

describe('nextFireAt：下一次提醒时刻', () => {
  it('当天 09:00 还没到 → 当天；已经过了 → 次日', () => {
    // 上海本地 2026-09-10 00:00（日记日仍是 09-09）
    assert.equal(isoOf(nextFireAt(at('2026-09-09T16:00:00Z'), SHANGHAI, '09:00')), '2026-09-10T01:00:00.000Z');
    // 上海本地 2026-09-10 03:00（日界前，仍属 09-09 的日记日）→ 仍然是当天 09:00
    assert.equal(isoOf(nextFireAt(at('2026-09-09T19:00:00Z'), SHANGHAI, '09:00')), '2026-09-10T01:00:00.000Z');
    // 已经是 10:00 → 次日 09:00
    assert.equal(isoOf(nextFireAt(at('2026-09-10T02:00:00Z'), SHANGHAI, '09:00')), '2026-09-11T01:00:00.000Z');
  });

  it('结果严格大于 now（恰好等于触发时刻时顺延到次日）', () => {
    const now = at('2026-09-10T01:00:00Z');
    assert.equal(isoOf(nextFireAt(now, SHANGHAI, '09:00')), '2026-09-11T01:00:00.000Z');
  });

  it('晚间 21:00 与半小时时区都正确', () => {
    // 上海本地 09-09 14:00：当天 21:00 还没到 → 仍是 09-09
    assert.equal(isoOf(nextFireAt(at('2026-09-09T06:00:00Z'), SHANGHAI, '21:00')), '2026-09-09T13:00:00.000Z');
    // 上海本地 09-10 00:00（日记日 09-09）：09-09 的 21:00 已过 → 顺延到 09-10，避免同一日记日重复提醒
    assert.equal(isoOf(nextFireAt(at('2026-09-09T16:00:00Z'), SHANGHAI, '21:00')), '2026-09-10T13:00:00.000Z');
    // 半小时时区（IST +05:30）：本地 09-09 21:30 时已过 → 顺延到次日 21:00
    assert.equal(isoOf(nextFireAt(at('2026-09-09T16:00:00Z'), KOLKATA, '21:00')), '2026-09-10T15:30:00.000Z');
  });

  it('DST 跳变当天的提醒不会落在不存在的时刻', () => {
    // 纽约 2026-03-08：02:30 不存在 → 顺延为 03:30 EDT（07:30Z）
    const now = at('2026-03-08T05:00:00Z'); // 本地 00:00 EST，日记日 03-07
    assert.equal(isoOf(nextFireAt(now, NEW_YORK, '02:30')), '2026-03-08T07:30:00.000Z');
  });

  it('连续两次调用总能前进，且间隔为一天', () => {
    const instants = [
      '2026-01-01T00:00:00Z',
      '2026-03-08T06:30:00Z',
      '2026-06-30T23:59:59Z',
      '2026-11-01T05:30:00Z',
      '2026-12-31T15:59:59Z',
    ];
    for (const raw of instants) {
      const now = at(raw);
      const first = nextFireAt(now, SHANGHAI, '09:00');
      const second = nextFireAt(first, SHANGHAI, '09:00');
      assert.ok(first.getTime() > now.getTime(), `${raw}: 第一次结果必须晚于 now`);
      assert.equal(second.getTime() - first.getTime(), 86_400_000, `${raw}: 第二次结果应正好晚一天`);
    }
  });

  it('拒绝非法入参', () => {
    assert.throws(() => nextFireAt(at('2026-09-10T00:00:00Z'), SHANGHAI, '25:00'));
    assert.throws(() => nextFireAt(at('2026-09-10T00:00:00Z'), SHANGHAI, '9:00'));
    assert.throws(() => nextFireAt(at('2026-09-10T00:00:00Z'), 'Not/AZone', '09:00'));
  });
});
