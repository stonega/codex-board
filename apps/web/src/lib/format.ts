export function formatTokenAmount(value: number): string {
  const absValue = Math.abs(value);
  if (absValue >= 1_000_000_000) {
    return `${formatTokenUnit(value / 1_000_000_000)}B`;
  }
  if (absValue >= 1_000_000) {
    return `${formatTokenUnit(value / 1_000_000)}M`;
  }

  return value.toLocaleString();
}

export function formatMoney(value: number | null): string {
  if (value === null) {
    return 'Unpriced';
  }

  return value.toLocaleString(undefined, {
    currency: 'USD',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: 'currency',
  });
}

function formatTokenUnit(value: number): string {
  const absValue = Math.abs(value);
  const maximumFractionDigits = absValue < 10 ? 2 : absValue < 100 ? 1 : 0;
  return value.toLocaleString(undefined, {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  });
}
