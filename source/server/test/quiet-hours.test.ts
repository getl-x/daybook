/**
 * 静默时段纯函数：窗口内/外、跨午夜、推迟到窗口结束、超上限 skip、DST 边界。
 * 时区计算全部走 @daybook/shared，测试里也用它构造输入，避免手算偏移。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveLocal } from '@daybook/shared';

import { applyQuietHours } from '../src/quiet-hours.ts';

const TZ = 'Asia/Shanghai';
const DISABLED = { enabled: false, start: '22:00', end: '07:00' };

describe('applyQuietHours', () => {
  it('未开启 → 原样投递', () => {
    const deliverAt = resolveLocal('2026-09-10', '23:00', TZ);
    assert.deepEqual(applyQuietHours({ deliverAt, quiet: DISABLED, timezone: TZ, dayStartHour: 4 }), {
      action: 'deliver',
    });
  });

  it('落在窗口外 → 原样投递', () => {
    const deliverAt = resolveLocal('2026-09-10', '15:00', TZ);
    const decision = applyQuietHours({
      deliverAt,
      quiet: { enabled: true, start: '22:00', end: '07:00' },
      timezone: TZ,
      dayStartHour: 4,
    });
    assert.equal(decision.action, 'deliver');
  });

  it('同一天窗口内 → 推迟到窗口结束', () => {
    const deliverAt = resolveLocal('2026-09-10', '13:00', TZ);
    const decision = applyQuietHours({
      deliverAt,
      quiet: { enabled: true, start: '12:00', end: '14:00' },
      timezone: TZ,
      dayStartHour: 4,
    });
    assert.equal(decision.action, 'defer');
    assert.equal(decision.at?.toISOString(), resolveLocal('2026-09-10', '14:00', TZ).toISOString());
  });

  it('跨午夜窗口（午夜前那一段）→ 推迟到次日窗口结束', () => {
    const deliverAt = resolveLocal('2026-09-10', '23:30', TZ);
    const decision = applyQuietHours({
      deliverAt,
      quiet: { enabled: true, start: '23:00', end: '02:00' },
      timezone: TZ,
      dayStartHour: 4,
    });
    assert.equal(decision.action, 'defer');
    assert.equal(decision.at?.toISOString(), resolveLocal('2026-09-11', '02:00', TZ).toISOString());
  });

  it('跨午夜窗口（凌晨那一段）→ 推迟到当天窗口结束', () => {
    const deliverAt = resolveLocal('2026-09-10', '01:00', TZ);
    const decision = applyQuietHours({
      deliverAt,
      quiet: { enabled: true, start: '23:00', end: '02:00' },
      timezone: TZ,
      dayStartHour: 4,
    });
    assert.equal(decision.action, 'defer');
    assert.equal(decision.at?.toISOString(), resolveLocal('2026-09-10', '02:00', TZ).toISOString());
  });

  it('推迟超过 12 小时 → skip（reason=quiet_hours）', () => {
    const deliverAt = resolveLocal('2026-09-10', '09:00', TZ);
    const decision = applyQuietHours({
      deliverAt,
      quiet: { enabled: true, start: '08:00', end: '23:00' },
      timezone: TZ,
      dayStartHour: 4,
    });
    assert.equal(decision.action, 'skip');
    assert.equal(decision.reason, 'quiet_hours');
    assert.equal(decision.at?.toISOString(), resolveLocal('2026-09-10', '23:00', TZ).toISOString());
  });

  it('推迟越过所属日记日的下一个日界（04:00）→ skip', () => {
    const deliverAt = resolveLocal('2026-09-10', '23:00', TZ);
    const decision = applyQuietHours({
      deliverAt,
      quiet: { enabled: true, start: '22:00', end: '07:00' },
      timezone: TZ,
      dayStartHour: 4,
    });
    assert.equal(decision.action, 'skip');
    assert.equal(decision.reason, 'quiet_hours');
  });

  it('窗口起止相等（防御）→ 视为全天窗口，同样受上限约束', () => {
    const deliverAt = resolveLocal('2026-09-10', '09:00', TZ);
    const decision = applyQuietHours({
      deliverAt,
      quiet: { enabled: true, start: '09:00', end: '09:00' },
      timezone: TZ,
      dayStartHour: 4,
    });
    assert.equal(decision.action, 'skip');
  });

  it('DST 春季跳变：推迟时长按真实时间算（窗口结束是跳变之后）', () => {
    const tz = 'America/New_York';
    const deliverAt = resolveLocal('2026-03-08', '01:30', tz);
    const decision = applyQuietHours({
      deliverAt,
      quiet: { enabled: true, start: '01:00', end: '03:30' },
      timezone: tz,
      dayStartHour: 4,
    });
    assert.equal(decision.action, 'defer');
    // 01:30 EST(06:30Z) → 03:30 EDT(07:30Z)：墙上 2 小时、真实只有 1 小时
    assert.equal(decision.at?.toISOString(), resolveLocal('2026-03-08', '03:30', tz).toISOString());
    assert.equal(decision.at?.toISOString(), '2026-03-08T07:30:00.000Z');
  });
});
