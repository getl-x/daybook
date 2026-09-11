/**
 * 本地提醒排程 planner 的单测（`web/test/notifications-plan.test.ts`）。
 *
 * 纯逻辑、零依赖：用 Node 内置 runner + 类型擦除跑：
 *   node --test "web/test/*.test.ts"
 * 只测不碰 window / localStorage / Capacitor 的纯函数（plan.ts）。
 *
 * 用例覆盖：开关组合、90 天 ×2 数量、过掉的槽位、DST（Europe/London）、
 * 早于日界的提醒归属、slotId 稳定性与范围、summarizeSlots、toReminderSettings 映射。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { wallClock } from '@daybook/shared';
import {
  planReminders,
  slotId,
  slotKey,
  summarizeSlots,
  toReminderSettings,
  type ReminderSettings,
} from '../src/lib/notifications/plan.ts';

const base = (overrides: Partial<ReminderSettings> = {}): ReminderSettings => ({
  morningEnabled: true,
  morningTime: '08:30',
  eveningEnabled: true,
  eveningTime: '21:00',
  dayStartHour: 4,
  timezone: 'Asia/Shanghai',
  ...overrides,
});

const countKind = (slots: ReturnType<typeof planReminders>, kind: 'morning' | 'evening'): number =>
  slots.filter((slot) => slot.kind === kind).length;

describe('planReminders：数量与开关', () => {
  it('早/晚都开 → 90 天共 180 条（各 90）', () => {
    // 上海本地 08:00（当天两个时刻都还没到）
    const now = new Date('2026-09-10T00:00:00Z');
    const slots = planReminders({ settings: base(), now });
    assert.equal(slots.length, 180);
    assert.equal(countKind(slots, 'morning'), 90);
    assert.equal(countKind(slots, 'evening'), 90);
  });

  it('只开一个 → 90 条，且全是那一种', () => {
    const now = new Date('2026-09-10T00:00:00Z');
    const slots = planReminders({ settings: base({ eveningEnabled: false }), now });
    assert.equal(slots.length, 90);
    assert.ok(slots.every((slot) => slot.kind === 'morning'));
  });

  it('两个都关 → 空', () => {
    const now = new Date('2026-09-10T00:00:00Z');
    const slots = planReminders({ settings: base({ morningEnabled: false, eveningEnabled: false }), now });
    assert.equal(slots.length, 0);
  });
});

describe('planReminders：过掉的槽位不出现', () => {
  it('当天已过时刻被丢弃，且结果全在未来', () => {
    // 上海本地 08:45 —— 08:30 的早间提醒已过
    const now = new Date('2026-09-10T00:45:00Z');
    const slots = planReminders({ settings: base(), now });
    assert.equal(countKind(slots, 'morning'), 89);
    assert.equal(countKind(slots, 'evening'), 90);
    assert.ok(slots.every((slot) => slot.fireAt.getTime() > now.getTime()));
    // 当天 08:30 那条不存在
    assert.ok(!slots.some((slot) => slot.kind === 'morning' && slot.entryDate === '2026-09-10'));
  });
});

describe('planReminders：DST 安全（Europe/London 春季跳变）', () => {
  it('跳变日当地 08:30 仍是 08:30', () => {
    const now = new Date('2026-03-01T00:00:00Z');
    const settings = base({ timezone: 'Europe/London' });
    const slots = planReminders({ settings, now });
    const slot = slots.find((candidate) => candidate.kind === 'morning' && candidate.entryDate === '2026-03-29');
    assert.ok(slot, '应包含 2026-03-29 的早间提醒');
    const wall = wallClock(slot!.fireAt, 'Europe/London');
    assert.equal(wall.year, 2026);
    assert.equal(wall.month, 3);
    assert.equal(wall.day, 29);
    assert.equal(wall.hour, 8);
    assert.equal(wall.minute, 30);
  });
});

describe('planReminders：早于日界的提醒归前一天', () => {
  it('03:30 / dayStartHour=4 → entryDate 是前一天', () => {
    // 上海本地 2026-09-10 00:00（仍属 09-09 日记日）
    const now = new Date('2026-09-09T16:00:00Z');
    const settings = base({ morningTime: '03:30', eveningEnabled: false });
    const slots = planReminders({ settings, now });
    assert.ok(slots.length > 0);
    const first = slots[0]!;
    assert.equal(first.kind, 'morning');
    // 触发时刻是 09-10 当地 03:30，但归属 09-09 日记日
    assert.equal(first.entryDate, '2026-09-09');
    const wall = wallClock(first.fireAt, 'Asia/Shanghai');
    assert.equal(wall.day, 10);
    assert.equal(wall.hour, 3);
    assert.equal(wall.minute, 30);
  });
});

describe('slotId / slotKey：稳定且落在 [1, 2**31)', () => {
  it('同一键两次调用得到同一个 id', () => {
    assert.equal(slotId('morning:2026-09-10'), slotId('morning:2026-09-10'));
    assert.equal(slotKey('morning', '2026-09-10'), 'morning:2026-09-10');
  });

  it('不同 kind / 不同日期得到不同 id', () => {
    assert.notEqual(slotId('morning:2026-09-10'), slotId('evening:2026-09-10'));
    assert.notEqual(slotId('morning:2026-09-10'), slotId('morning:2026-09-11'));
  });

  it('id 是正整数且 < 2**31（Android 通知 id 约束）', () => {
    const now = new Date('2026-09-10T00:00:00Z');
    const slots = planReminders({ settings: base(), now });
    for (const slot of slots) {
      assert.ok(Number.isInteger(slot.id), `${slot.key} 的 id 是整数`);
      assert.ok(slot.id > 0, `${slot.key} 的 id 为正`);
      assert.ok(slot.id < 2 ** 31, `${slot.key} 的 id < 2**31`);
    }
  });
});

describe('summarizeSlots：条数与首尾时刻', () => {
  it('空数组 → count 0，首尾都是 null', () => {
    assert.deepEqual(summarizeSlots([]), { count: 0, firstAt: null, lastAt: null });
  });

  it('非空 → count 等于条数，首尾是最早/最晚', () => {
    const now = new Date('2026-09-10T00:00:00Z');
    const slots = planReminders({ settings: base(), now });
    const summary = summarizeSlots(slots);
    assert.equal(summary.count, 180);
    assert.equal(summary.firstAt?.getTime(), slots[0]!.fireAt.getTime());
    assert.equal(summary.lastAt?.getTime(), slots[slots.length - 1]!.fireAt.getTime());
  });
});

describe('toReminderSettings：snake_case → camelCase 映射', () => {
  it('字段一一对应', () => {
    const mapped = toReminderSettings({
      timezone: 'Europe/London',
      day_start_hour: 5,
      reminders: {
        morning_enabled: true,
        morning_time: '07:15',
        evening_enabled: false,
        evening_time: '22:45',
      },
    });
    assert.deepEqual(mapped, {
      morningEnabled: true,
      morningTime: '07:15',
      eveningEnabled: false,
      eveningTime: '22:45',
      dayStartHour: 5,
      timezone: 'Europe/London',
    });
  });
});
