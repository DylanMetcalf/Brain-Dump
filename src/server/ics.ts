// Read-only iCalendar feed so Apple Calendar, Google Calendar or Outlook can subscribe
// to events Brain Dump manages locally — a legitimate, OS-sanctioned bridge.

import type { UserState } from '../core/types.js';

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function stamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ' ' + rest.slice(74);
  }
  out.push(rest);
  return out.join('\r\n');
}

export function toICS(state: UserState, now: Date): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Brain Dump//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(`${state.profile.assistantName ?? 'Brain Dump'} — Brain Dump`)}`];
  const since = now.getTime() - 30 * 86400000;
  for (const e of state.events) {
    if (e.source !== 'local' || Date.parse(e.end) < since) continue;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${e.id}@braindump`);
    lines.push(`DTSTAMP:${stamp(e.updatedAt)}`);
    if (e.allDay) {
      const d = e.start.slice(0, 10).replace(/-/g, '');
      lines.push(`DTSTART;VALUE=DATE:${d}`);
    } else {
      lines.push(`DTSTART:${stamp(e.start)}`);
      lines.push(`DTEND:${stamp(e.end)}`);
    }
    lines.push(`SUMMARY:${esc(e.title)}`);
    if (e.status === 'cancelled') lines.push('STATUS:CANCELLED');
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    const desc = [e.notes, e.meeting?.url].filter(Boolean).join('\n');
    if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
    if (e.meeting?.url) lines.push(`URL:${e.meeting.url}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
