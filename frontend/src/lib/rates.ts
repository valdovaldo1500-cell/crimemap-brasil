export function calcRate(count: number, population: number | null | undefined): number | null {
  if (!population || population === 0) return null;
  return (count / population) * 100_000;
}

export function formatRate(rate: number | null): string {
  if (rate === null) return '—';
  if (rate >= 100) return rate.toFixed(0);
  if (rate >= 10) return rate.toFixed(1);
  return rate.toFixed(2);
}
