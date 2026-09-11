/**
 * server.ts 里纯函数的单测（normalizeServerBase / isValidServerBase / resolveServerBase）。
 *
 * 用 Node 内置 runner + 类型擦除跑，零依赖：
 *   node --test "web/test/*.test.ts"
 * 只测不碰 window / localStorage / import.meta.env 的纯函数。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isValidServerBase, normalizeServerBase, resolveServerBase } from '../src/lib/server.ts';

describe('normalizeServerBase：清洗与校验', () => {
  it('空串与纯空白都归一成空串', () => {
    assert.equal(normalizeServerBase(''), '');
    assert.equal(normalizeServerBase('   '), '');
    assert.equal(normalizeServerBase('\t\n'), '');
  });

  it('去掉尾部斜杠（含多个）与首尾空白', () => {
    assert.equal(normalizeServerBase('https://a.example.com/'), 'https://a.example.com');
    assert.equal(normalizeServerBase('https://a.example.com///'), 'https://a.example.com');
    assert.equal(normalizeServerBase('  https://a.example.com/  '), 'https://a.example.com');
  });

  it('合法的 https 原样保留', () => {
    assert.equal(normalizeServerBase('https://a.example.com'), 'https://a.example.com');
  });

  it('带路径前缀的 https 保留整条地址', () => {
    assert.equal(normalizeServerBase('https://a.example.com/api'), 'https://a.example.com/api');
    assert.equal(normalizeServerBase('https://a.example.com/api/'), 'https://a.example.com/api');
  });

  it('拒绝 http://（只能 https）', () => {
    assert.equal(normalizeServerBase('http://a.example.com'), '');
  });

  it('拒绝没有协议的主机名', () => {
    assert.equal(normalizeServerBase('example.com'), '');
    assert.equal(normalizeServerBase('//a.example.com'), '');
    assert.equal(normalizeServerBase('a.example.com:8090'), '');
  });

  it('拒绝只有 https:// 却没有主机名', () => {
    assert.equal(normalizeServerBase('https://'), '');
    assert.equal(normalizeServerBase('https:// '), '');
  });
});

describe('isValidServerBase：空串合法（与网页同源）', () => {
  it('空串与纯空白视为合法', () => {
    assert.equal(isValidServerBase(''), true);
    assert.equal(isValidServerBase('   '), true);
  });

  it('合法 https 地址（含尾斜杠）视为合法', () => {
    assert.equal(isValidServerBase('https://a.example.com'), true);
    assert.equal(isValidServerBase('https://a.example.com/'), true);
  });

  it('http:// 与无协议主机名视为不合法', () => {
    assert.equal(isValidServerBase('http://a.example.com'), false);
    assert.equal(isValidServerBase('example.com'), false);
  });
});

describe('resolveServerBase：取值优先级', () => {
  it('stored 非空时胜过 buildDefault', () => {
    assert.equal(
      resolveServerBase('https://stored.example.com', 'https://build.example.com'),
      'https://stored.example.com',
    );
  });

  it('stored 为空时回落到 buildDefault', () => {
    assert.equal(resolveServerBase('', 'https://build.example.com'), 'https://build.example.com');
  });

  it('两者都空时得到空串', () => {
    assert.equal(resolveServerBase('', ''), '');
  });
});
