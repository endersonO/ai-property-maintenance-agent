// Closed reporting periods relative to a fixed reference date (asOf). Only periods that ended
// before asOf are reported, so an incomplete quarter is never compared with a complete one.

export const PERIODS = ["last_closed_month", "last_closed_quarter", "last_12_closed_months"] as const;
export type PeriodKey = (typeof PERIODS)[number];

export type Range = { label: string; start: Date; end: Date };
export type PeriodRanges = { current: Range; previous: Range; lastYear: Range; months: number };

const utc = (y: number, m: number) => new Date(Date.UTC(y, m, 1));
const monthLabel = (d: Date) => d.toISOString().slice(0, 7);
const quarterLabel = (d: Date) => `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;

function shift(range: Range, months: number, label: (d: Date) => string): Range {
  const start = utc(range.start.getUTCFullYear(), range.start.getUTCMonth() - months);
  const end = utc(range.end.getUTCFullYear(), range.end.getUTCMonth() - months);
  return { label: label(start), start, end };
}

export function periodRanges(period: PeriodKey, asOf: Date): PeriodRanges {
  const y = asOf.getUTCFullYear();
  const m = asOf.getUTCMonth();
  if (period === "last_closed_month") {
    const current = { label: monthLabel(utc(y, m - 1)), start: utc(y, m - 1), end: utc(y, m) };
    return { current, previous: shift(current, 1, monthLabel), lastYear: shift(current, 12, monthLabel), months: 1 };
  }
  if (period === "last_closed_quarter") {
    // The quarter that contains asOf is not closed yet: report the one before it.
    const thisQuarterStart = utc(y, m - (m % 3));
    const start = utc(thisQuarterStart.getUTCFullYear(), thisQuarterStart.getUTCMonth() - 3);
    const current = { label: quarterLabel(start), start, end: thisQuarterStart };
    return { current, previous: shift(current, 3, quarterLabel), lastYear: shift(current, 12, quarterLabel), months: 3 };
  }
  const twelve = (start: Date): Range => ({
    label: `${monthLabel(start)}..${monthLabel(utc(start.getUTCFullYear(), start.getUTCMonth() + 11))}`,
    start,
    end: utc(start.getUTCFullYear(), start.getUTCMonth() + 12),
  });
  const current = twelve(utc(y, m - 12));
  const previous = twelve(utc(y, m - 24));
  return { current, previous, lastYear: previous, months: 12 };
}
