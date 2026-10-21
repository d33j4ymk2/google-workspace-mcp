/**
 * suggestTime — find meeting slots everyone is free for.
 *
 * Pure: busy intervals in, slots out. The handler fetches free/busy and formats; this
 * file only does the arithmetic, so it is testable without Google or a clock.
 *
 * Working hours are wall-clock times in ONE time zone (the organizer's calendar zone by
 * default). Converting a wall-clock time to an instant needs that zone's offset ON THAT
 * DAY, which changes across DST, so each day is converted on its own rather than by
 * adding 24h to the previous one.
 */

export interface Interval {
  start: number; // epoch ms
  end: number;
}

export interface SuggestOptions {
  /** Busy intervals of everyone involved, in any order, overlapping or not. */
  busy: Interval[];
  rangeStart: number;
  rangeEnd: number;
  durationMinutes: number;
  timeZone: string;
  /** Wall-clock hours in `timeZone`, e.g. 9 and 17. */
  workdayStart: number;
  workdayEnd: number;
  includeWeekends: boolean;
  maxSuggestions: number;
  /** Candidate starts are aligned to this many minutes. */
  stepMinutes?: number;
}

/** Offset of `timeZone` from UTC at instant `at`, in ms (positive east of UTC). */
function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` reads y-m-d h:00. */
export function zonedTime(y: number, m: number, d: number, h: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, h);
  const first = guess - zoneOffset(guess, timeZone);
  // Re-measure at the result: the guess may sit on the other side of a DST change.
  return guess - zoneOffset(first, timeZone);
}

/** Calendar date (y, m, d) and weekday (0 = Sunday) of instant `at` in `timeZone`. */
function zonedDate(at: number, timeZone: string): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), weekday };
}

/** Sort and merge overlapping or touching intervals. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const i of sorted) {
    const last = merged[merged.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else merged.push({ ...i });
  }
  return merged;
}

/**
 * Up to `maxSuggestions` free slots of exactly `durationMinutes`, earliest first.
 *
 * At most one slot is taken from each free gap, so the suggestions spread across the
 * range instead of offering 9:00, 9:30 and 10:00 of the same empty morning.
 */
export function suggestSlots(opts: SuggestOptions): Interval[] {
  const duration = opts.durationMinutes * 60_000;
  const step = (opts.stepMinutes ?? 30) * 60_000;
  const busy = mergeIntervals(opts.busy);
  const slots: Interval[] = [];

  // Walk calendar days in the zone. Starting at noon on each day keeps the walk on the
  // right date even on a 23- or 25-hour DST day.
  let day = zonedDate(opts.rangeStart, opts.timeZone);
  for (let guard = 0; guard < 370 && slots.length < opts.maxSuggestions; guard++) {
    const dayStart = zonedTime(day.y, day.m, day.d, opts.workdayStart, opts.timeZone);
    if (dayStart >= opts.rangeEnd) break;
    const isWeekend = day.weekday === 0 || day.weekday === 6;

    if (opts.includeWeekends || !isWeekend) {
      const windowStart = Math.max(dayStart, opts.rangeStart);
      const windowEnd = Math.min(zonedTime(day.y, day.m, day.d, opts.workdayEnd, opts.timeZone), opts.rangeEnd);

      // Free gaps inside today's working window.
      let cursor = windowStart;
      const gaps: Interval[] = [];
      for (const b of busy) {
        if (b.end <= cursor) continue;
        if (b.start >= windowEnd) break;
        if (b.start > cursor) gaps.push({ start: cursor, end: b.start });
        cursor = Math.max(cursor, b.end);
      }
      if (cursor < windowEnd) gaps.push({ start: cursor, end: windowEnd });

      for (const gap of gaps) {
        // Align to the step, measured from the working day's start.
        const aligned = dayStart + Math.ceil((gap.start - dayStart) / step) * step;
        if (aligned + duration <= gap.end) {
          slots.push({ start: aligned, end: aligned + duration });
          if (slots.length >= opts.maxSuggestions) break;
        }
      }
    }

    const nextNoon = zonedTime(day.y, day.m, day.d, 12, opts.timeZone) + 24 * 3_600_000;
    day = zonedDate(nextNoon, opts.timeZone);
  }
  return slots;
}

/** "Tue 21 Oct, 14:00–14:30" in `timeZone`. */
export function formatSlot(slot: Interval, timeZone: string): string {
  const date = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${date.format(slot.start)}, ${time.format(slot.start)}–${time.format(slot.end)}`;
}
