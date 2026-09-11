/**
 * describeCurrentDevice 的纯逻辑单测：按不同 UA 字符串推断设备名与平台。
 *
 * 用 Node 内置 runner + 类型擦除跑（web/test/*.test.ts）：
 *   node --test "web/test/*.test.ts"
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeCurrentDevice } from '../src/lib/push.ts';

const UA = {
  iPhoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  iPadSafari:
    'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  iPhoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
};

describe('describeCurrentDevice：UA → label/platform', () => {
  it('iPhone Safari → “iPhone · Safari”，platform=ios-pwa', () => {
    assert.deepEqual(describeCurrentDevice(UA.iPhoneSafari), { label: 'iPhone · Safari', platform: 'ios-pwa' });
  });

  it('iPad Safari → “iPad · Safari”，platform=ios-pwa', () => {
    assert.deepEqual(describeCurrentDevice(UA.iPadSafari), { label: 'iPad · Safari', platform: 'ios-pwa' });
  });

  it('iOS 上的 Chrome（CriOS）识别为 Chrome，platform=ios-pwa', () => {
    assert.deepEqual(describeCurrentDevice(UA.iPhoneChrome), { label: 'iPhone · Chrome', platform: 'ios-pwa' });
  });

  it('Android Chrome → “Android · Chrome”，platform=web', () => {
    assert.deepEqual(describeCurrentDevice(UA.androidChrome), { label: 'Android · Chrome', platform: 'web' });
  });

  it('Mac Chrome → “Mac · Chrome”', () => {
    assert.deepEqual(describeCurrentDevice(UA.macChrome), { label: 'Mac · Chrome', platform: 'web' });
  });

  it('Windows Edge → “Windows · Edge”（先认 Edge 再认 Chrome）', () => {
    assert.deepEqual(describeCurrentDevice(UA.windowsEdge), { label: 'Windows · Edge', platform: 'web' });
  });

  it('Windows Firefox → “Windows · Firefox”', () => {
    assert.deepEqual(describeCurrentDevice(UA.windowsFirefox), { label: 'Windows · Firefox', platform: 'web' });
  });

  it('认不出的 UA → 退回截断的整串 UA（≤ 40 字符），platform=web', () => {
    assert.deepEqual(describeCurrentDevice('curl/8.0.1'), { label: 'curl/8.0.1', platform: 'web' });
    const long = 'z'.repeat(80);
    const result = describeCurrentDevice(long);
    assert.equal(result.label.length, 40);
    assert.equal(result.label, long.slice(0, 40));
    assert.equal(result.platform, 'web');
  });
});
