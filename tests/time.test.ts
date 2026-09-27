import { describe, it, expect } from 'vitest';
import { parseWhen, resolveInstant, zonedToUtc, zonedParts, formatWhen } from '../src/core/time.js';

const TZ = 'Europe/London';
// Sunday 27 Sep 2026, 10:00 London (BST, UTC+1)
const NOW = zonedToUtc({ year: 2026, month: 9, day: 27, hour: 10, minute: 0 }, TZ);

function when(text: string, opts = {}) {
  const p = parseWhen(text, NOW, TZ, opts);
  const d = resolveInstant(p, NOW, TZ);
  return { p, d, local: d ? zonedParts(d, TZ) : undefined };
}

describe('time parsing', () => {
  it('handles DST-aware conversion', () => {
    expect(NOW.toISOString()).toBe('2026-09-27T09:00:00.000Z');
    const winter = zonedToUtc({ year: 2026, month: 12, day: 1, hour: 10, minute: 0 }, TZ);
    expect(winter.toISOString()).toBe('2026-12-01T10:00:00.000Z');
    const ny = zonedToUtc({ year: 2026, month: 10, day: 1, hour: 14, minute: 0 }, 'America/New_York');
    expect(ny.toISOString()).toBe('2026-10-01T18:00:00.000Z');
  });
  it('tomorrow at 2 → 14:00 tomorrow', () => {
    const { local, p } = when('yoga tomorrow at 2');
    expect(local).toMatchObject({ day: 28, hour: 14, minute: 0 });
    expect(p.rest).toBe('yoga');
  });
  it('weekday names', () => {
    expect(when('Tuesday at 9').local).toMatchObject({ day: 29, hour: 9 });
    expect(when('on friday at 3pm').local).toMatchObject({ day: 2, month: 10, hour: 15 });
    expect(when('next wednesday').local).toMatchObject({ day: 30 });
  });
  it('bare numbers only in answer mode', () => {
    expect(when('Two.', { answerMode: true }).local).toMatchObject({ hour: 14 });
    expect(when('I need two eggs').p.time).toBeUndefined();
  });
  it('clock formats', () => {
    expect(when('14:30').local).toMatchObject({ hour: 14, minute: 30 });
    expect(when('half past three').local).toMatchObject({ hour: 15, minute: 30 });
    expect(when('at 7 in the evening').local).toMatchObject({ hour: 19 });
    expect(when('9am').local).toMatchObject({ hour: 9 });
    expect(when('noon on the 14th').local).toMatchObject({ day: 14, month: 10, hour: 12 });
    expect(when('October 3 at 10').local).toMatchObject({ day: 3, month: 10, hour: 10 });
  });
  it('relative and shifts', () => {
    expect(when('in 2 hours').d!.getTime() - NOW.getTime()).toBe(7200000);
    expect(parseWhen('push it back an hour', NOW, TZ).shiftMs).toBe(3600000);
    expect(parseWhen('make it earlier', NOW, TZ).shiftMs).toBe(-3600000);
    expect(parseWhen('remind me later', NOW, TZ).part).toBe('later');
  });
  it('span and zone hints', () => {
    expect(parseWhen('change that to next week', NOW, TZ).span?.label).toBe('next week');
    expect(parseWhen("2pm rick's time", NOW, TZ).zoneHint).toMatchObject({ kind: 'theirs', who: 'rick' });
  });
  it('formats', () => {
    const d = when('tomorrow at 2').d!;
    expect(formatWhen(d, TZ, NOW)).toBe('tomorrow at 2 PM');
  });
});
