import { describe, expect, it } from 'vitest';
import { suggestSlots, mergeIntervals, zonedTime, formatSlot } from '../../../services/calendar/suggest.js';

const Z = 'Europe/Zurich';
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

const base = {
  durationMinutes: 30, timeZone: Z, workdayStart: 9, workdayEnd: 17,
  includeWeekends: false, maxSuggestions: 5,
};

describe('zonedTime', () => {
  it('converts wall-clock hours to instants on both sides of the DST change', () => {
    // Zurich is UTC+2 in summer time, UTC+1 after 25 Oct 2026.
    expect(iso(zonedTime(2026, 10, 21, 9, Z))).toBe('2026-10-21T07:00:00.000Z');
    expect(iso(zonedTime(2026, 10, 26, 9, Z))).toBe('2026-10-26T08:00:00.000Z');
  });
});

describe('mergeIntervals', () => {
  it('merges overlapping and touching intervals and drops empty ones', () => {
    expect(mergeIntervals([
      { start: 5, end: 8 }, { start: 1, end: 3 }, { start: 3, end: 4 }, { start: 7, end: 10 }, { start: 9, end: 9 },
    ])).toEqual([{ start: 1, end: 4 }, { start: 5, end: 10 }]);
  });
});

describe('suggestSlots', () => {
  it('skips busy time and takes one slot per free gap, inside working hours', () => {
    const slots = suggestSlots({
      ...base,
      rangeStart: at('2026-10-21T06:00:00Z'), // Wed 08:00 Zurich
      rangeEnd: at('2026-10-21T22:00:00Z'),
      busy: [
        { start: at('2026-10-21T07:00:00Z'), end: at('2026-10-21T08:15:00Z') }, // 09:00–10:15
        { start: at('2026-10-21T09:00:00Z'), end: at('2026-10-21T14:00:00Z') }, // 11:00–16:00
      ],
    });
    expect(slots.map((s) => formatSlot(s, Z))).toEqual([
      'Wed 21 Oct, 10:30–11:00', // aligned up from 10:15
      'Wed 21 Oct, 16:00–16:30',
    ]);
  });

  it('never returns a slot shorter than the meeting or past the end of the day', () => {
    const slots = suggestSlots({
      ...base, durationMinutes: 60,
      rangeStart: at('2026-10-21T13:00:00Z'), // 15:00 Zurich
      rangeEnd: at('2026-10-21T22:00:00Z'),
      busy: [{ start: at('2026-10-21T13:30:00Z'), end: at('2026-10-21T14:30:00Z') }], // 15:30–16:30
    });
    expect(slots).toEqual([]);
  });

  it('skips weekends unless asked, and spans the DST change', () => {
    const range = { rangeStart: at('2026-10-23T16:00:00Z'), rangeEnd: at('2026-10-27T00:00:00Z') }; // Fri evening → Tue
    const weekdays = suggestSlots({ ...base, ...range, busy: [], maxSuggestions: 1 });
    expect(weekdays.map((s) => formatSlot(s, Z))).toEqual(['Mon 26 Oct, 09:00–09:30']);
    expect(iso(weekdays[0].start)).toBe('2026-10-26T08:00:00.000Z'); // UTC+1 after the change

    const withWeekends = suggestSlots({ ...base, ...range, busy: [], maxSuggestions: 2, includeWeekends: true });
    expect(withWeekends.map((s) => formatSlot(s, Z))).toEqual(['Sat 24 Oct, 09:00–09:30', 'Sun 25 Oct, 09:00–09:30']);
  });

  it('stops at maxSuggestions', () => {
    const slots = suggestSlots({
      ...base, maxSuggestions: 3, busy: [],
      rangeStart: at('2026-10-19T00:00:00Z'), rangeEnd: at('2026-10-31T00:00:00Z'),
    });
    expect(slots).toHaveLength(3);
  });
});
