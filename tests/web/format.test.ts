import { describe, expect, test } from 'bun:test';

import { formatMoney, formatTokenAmount } from '../../apps/web/src/lib/format';

describe('web formatters', () => {
  test('formats large token amounts with M and B suffixes', () => {
    expect(formatTokenAmount(1_250)).toBe('1,250');
    expect(formatTokenAmount(999_999)).toBe('999,999');
    expect(formatTokenAmount(1_000_000)).toBe('1M');
    expect(formatTokenAmount(28_748_983)).toBe('28.7M');
    expect(formatTokenAmount(1_866_088_281)).toBe('1.87B');
  });

  test('formats money costs with exactly two decimals', () => {
    expect(formatMoney(0)).toBe('$0.00');
    expect(formatMoney(0.00125)).toBe('$0.00');
    expect(formatMoney(40.255)).toBe('$40.26');
    expect(formatMoney(1591.0541)).toBe('$1,591.05');
    expect(formatMoney(null)).toBe('Unpriced');
  });
});
