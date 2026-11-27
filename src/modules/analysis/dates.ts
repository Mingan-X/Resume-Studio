import { z } from 'zod';
import { parsedResumeSchema } from '../../contracts/parsed-resume.js';

export const normalizedEmploymentSchema = z.object({ asOfDate: z.iso.date(), knownMonths: z.int().nonnegative(),
  incompleteIntervals: z.int().nonnegative(), intervals: z.array(z.object({ startMonth: z.int(), endMonth: z.int() }).strict()),
}).strict();
const month = (value: string | null): number | null => {
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  const year = Number(value.slice(0, 4)); return year >= 1900 && year <= 9999 ? year * 12 + Number(value.slice(5)) - 1 : null;
};
// Month-granularity intervals: no invented month for year-only dates and no double-counting overlapping work.
export function normalizeEmployment(raw: unknown, frozenDate: unknown) {
  const resume = parsedResumeSchema.parse(raw), asOfDate = z.iso.date().parse(frozenDate), asOf = month(asOfDate.slice(0, 7));
  if (asOf === null) throw new Error('AS_OF_DATE_UNSUPPORTED');
  const intervals: { startMonth: number; endMonth: number }[] = []; let incompleteIntervals = 0;
  for (const work of resume.work) {
    const start = month(work.startDate), end = work.ongoing === true && work.endDate === null ? asOf : month(work.endDate);
    if (start === null || end === null || start > end || end > asOf || (work.ongoing === true && work.endDate !== null)) { incompleteIntervals++; continue; }
    // End month is exclusive. This is a month-granularity metric, not a claim about exact elapsed days.
    intervals.push({ startMonth: start, endMonth: end });
  }
  intervals.sort((a, b) => a.startMonth - b.startMonth || a.endMonth - b.endMonth);
  const merged: typeof intervals = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.startMonth <= previous.endMonth) previous.endMonth = Math.max(previous.endMonth, interval.endMonth);
    else merged.push({ ...interval });
  }
  return normalizedEmploymentSchema.parse({ asOfDate, knownMonths: merged.reduce((sum, item) => sum + item.endMonth - item.startMonth, 0), incompleteIntervals, intervals: merged });
}
