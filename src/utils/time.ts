import { env } from '../config/env';

const tz = env.APP_TIMEZONE;

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });

/** YYYY-MM-DD in company timezone */
export const dateKey = (d: Date = new Date()) => dateFmt.format(d);
export const timeLabel = (d?: Date | null) => (d ? timeFmt.format(d) : '');

/** pure calendar maths on YYYY-MM-DD strings (UTC-based, no tz drift) */
const toUTC = (s: string) => new Date(`${s}T00:00:00Z`);
const fromUTC = (d: Date) => d.toISOString().slice(0, 10);

export const addDays = (s: string, n: number) => fromUTC(new Date(toUTC(s).getTime() + n * 86_400_000));
export const weekdayIndex = (s: string) => toUTC(s).getUTCDay(); // 0 = Sun
export const isWeekend = (s: string) => [0, 6].includes(weekdayIndex(s));
export const weekdayShort = (s: string) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekdayIndex(s)];

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function monthDays(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

export function monthLabel(month: string) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Monday of the week that contains `s` */
export function weekStart(s: string) {
  const idx = weekdayIndex(s);
  return addDays(s, -((idx + 6) % 7));
}

export const hoursOf = (ms: number) => Math.round((ms / 3_600_000) * 100) / 100;

export function fmtDuration(ms: number) {
  const mins = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}
