import { describe, expect, it } from 'vitest';
import { regionEmojiToCode } from './utils';
import { buildTagChips, splitRemarkTags } from './parseTags';

describe('regionEmojiToCode', () => {
  it('把旗帜 emoji 转成 ISO 3166-1 alpha-2 代码', () => {
    expect(regionEmojiToCode('🇯🇵')).toBe('JP');
    expect(regionEmojiToCode('🇩🇪')).toBe('DE');
    expect(regionEmojiToCode('🇺🇸')).toBe('US');
    expect(regionEmojiToCode('🇸🇬')).toBe('SG');
    expect(regionEmojiToCode('🇬🇧')).toBe('GB');
    expect(regionEmojiToCode('🇦🇺')).toBe('AU');
  });

  it('非旗帜输入返回空串', () => {
    expect(regionEmojiToCode('')).toBe('');
    expect(regionEmojiToCode(null)).toBe('');
    expect(regionEmojiToCode(undefined)).toBe('');
    expect(regionEmojiToCode('JP')).toBe('');
    expect(regionEmojiToCode('日本')).toBe('');
    // 两对旗帜（4 个区域指示符）不是合法的单国代码
    expect(regionEmojiToCode('🇯🇵🇩🇪')).toBe('');
    // 带变体选择符的写法也要能认
    expect(regionEmojiToCode('🇯🇵\ufe0f')).toBe('JP');
  });
});

describe('splitRemarkTags', () => {
  it('半角/全角逗号、分号、顿号都能拆', () => {
    expect(splitRemarkTags('CN2 GIA,三网优化,晚高峰也稳')).toEqual([
      'CN2 GIA',
      '三网优化',
      '晚高峰也稳',
    ]);
    expect(splitRemarkTags('A，B；C、D')).toEqual(['A', 'B', 'C', 'D']);
  });

  it('去空、去重、容忍首尾空白', () => {
    expect(splitRemarkTags(' , a, a ,')).toEqual(['a']);
    expect(splitRemarkTags('')).toEqual([]);
    expect(splitRemarkTags(null)).toEqual([]);
    expect(splitRemarkTags(undefined)).toEqual([]);
  });
});

describe('buildTagChips', () => {
  it('Komari tags 在前、备注拆出的标签在后', () => {
    const chips = buildTagChips('prod<red>,edge', 'CN2 GIA,三网优化');
    expect(chips.map(c => c.label)).toEqual(['prod', 'edge', 'CN2 GIA', '三网优化']);
    expect(chips[0]).toMatchObject({ color: 'red', isRemark: false });
    expect(chips[2]).toMatchObject({ color: null, isRemark: true });
  });

  it('两个来源都为空时返回空数组', () => {
    expect(buildTagChips('', '')).toEqual([]);
    expect(buildTagChips(null, null)).toEqual([]);
    expect(buildTagChips(undefined, undefined)).toEqual([]);
  });
});
