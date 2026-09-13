import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EVENING_EARLIEST_MINUTES,
  eveningThresholdMinutes,
  isEveningTime,
  localMinutes,
  parseClock,
} from '../src/lib/dayphase.ts';

describe('parseClock', () => {
  it('解析 HH:MM 和 H:MM', () => {
    assert.equal(parseClock('00:00'), 0);
    assert.equal(parseClock('09:05'), 9 * 60 + 5);
    assert.equal(parseClock('9:05'), 9 * 60 + 5);
    assert.equal(parseClock(' 21:30 '), 21 * 60 + 30);
  });

  it('非法输入一律返回 null', () => {
    for (const bad of ['', '   ', '24:00', '12:60', '12', '12:5', 'abc', '12:5x', '12:005']) {
      assert.equal(parseClock(bad), null, `应该判为非法：${JSON.stringify(bad)}`);
    }
  });
});

describe('eveningThresholdMinutes：晚间总结不能早于 18:00 出现', () => {
  it('设置比 18:00 晚就按设置走', () => {
    assert.equal(eveningThresholdMinutes('21:30'), 21 * 60 + 30);
    assert.equal(eveningThresholdMinutes('18:00'), EVENING_EARLIEST_MINUTES);
  });

  it('设置比 18:00 早也压到 18:00', () => {
    assert.equal(eveningThresholdMinutes('08:30'), EVENING_EARLIEST_MINUTES);
    assert.equal(eveningThresholdMinutes('00:00'), EVENING_EARLIEST_MINUTES);
  });

  it('没设置或不合法时退回 18:00', () => {
    assert.equal(eveningThresholdMinutes(''), EVENING_EARLIEST_MINUTES);
    assert.equal(eveningThresholdMinutes('晚上九点'), EVENING_EARLIEST_MINUTES);
  });
});

describe('isEveningTime', () => {
  it('默认（没设提醒时间）时 17:59 不出现、18:00 出现', () => {
    assert.equal(isEveningTime(17 * 60 + 59, ''), false);
    assert.equal(isEveningTime(18 * 60, ''), true);
  });

  it('用户把晚间提醒设到 21:00 就等到 21:00', () => {
    assert.equal(isEveningTime(20 * 60 + 59, '21:00'), false);
    assert.equal(isEveningTime(21 * 60, '21:00'), true);
  });
});

describe('localMinutes', () => {
  it('取本地时间的 时*60+分', () => {
    assert.equal(localMinutes(new Date(2026, 8, 12, 7, 5)), 7 * 60 + 5);
    assert.equal(localMinutes(new Date(2026, 8, 12, 0, 0)), 0);
  });
});
