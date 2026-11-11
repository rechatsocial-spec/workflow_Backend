import { Types } from 'mongoose';
import { TARGET_MS, UPDATE_INTERVAL_MS } from '../config/env';
import { Attendance } from '../models/attendance.model';
import { BreakRecord } from '../models/breakRecord.model';
import { WorkSession } from '../models/workSession.model';
import { WorkUpdate } from '../models/workUpdate.model';
import { dateKey } from '../utils/time';

type Interval = { startTime: Date; endTime?: Date | null; durationMs?: number | null };

/** Break time is always subtracted: worked = (end|now) - start - breaks */
export function totalsFor(session: { startTime: Date; endTime?: Date | null }, breaks: Interval[], now = new Date()) {
  const end = session.endTime ?? now;
  const breakMs = breaks.reduce((sum, b) => {
    const bEnd = b.endTime ?? end;
    return sum + Math.max(0, +bEnd - +b.startTime);
  }, 0);
  const elapsedMs = Math.max(0, +end - +session.startTime);
  return { elapsedMs, breakMs, workedMs: Math.max(0, elapsedMs - breakMs) };
}

export function attendanceStatus(workedMs: number, open: boolean) {
  if (open) return 'in_progress' as const;
  if (workedMs >= TARGET_MS) return 'present' as const;
  if (workedMs >= TARGET_MS / 2) return 'half_day' as const;
  return 'short' as const;
}

/** attach breaks, live totals and update counts to lean sessions */
export async function decorateSessions<T extends { _id: any; startTime: Date; endTime?: Date | null }>(sessions: T[]) {
  if (!sessions.length) return [];
  const ids = sessions.map((s) => s._id);
  const [breaks, updates] = await Promise.all([
    BreakRecord.find({ session: { $in: ids } }).sort({ startTime: 1 }).lean(),
    WorkUpdate.aggregate([
      { $match: { session: { $in: ids } } },
      { $group: { _id: '$session', count: { $sum: 1 }, last: { $max: '$submittedAt' } } },
    ]),
  ]);
  const bMap = new Map<string, typeof breaks>();
  breaks.forEach((b) => bMap.set(String(b.session), [...(bMap.get(String(b.session)) ?? []), b]));
  const uMap = new Map(updates.map((u) => [String(u._id), u]));
  const now = new Date();
  return sessions.map((s) => {
    const sb = bMap.get(String(s._id)) ?? [];
    return {
      ...s,
      breaks: sb,
      ...totalsFor(s, sb, now),
      updatesCount: uMap.get(String(s._id))?.count ?? 0,
      lastUpdateAt: uMap.get(String(s._id))?.last ?? null,
    };
  });
}

/** Everything the employee dashboard needs about "today". */
export async function getTodayState(employeeId: Types.ObjectId | string) {
  const today = dateKey();
  // an unclosed session from a previous day must still be recoverable/endable
  const session =
    (await WorkSession.findOne({ employee: employeeId, isOpen: true }).lean()) ??
    (await WorkSession.findOne({ employee: employeeId, date: today }).lean());
  const serverNow = new Date();
  if (!session) {
    return { status: 'not_started' as const, session: null, breaks: [], serverNow, targetMs: TARGET_MS, workedMs: 0, breakMs: 0, remainingMs: TARGET_MS, updatesToday: 0, updateDue: false, nextUpdateDue: null };
  }
  const [decorated] = await decorateSessions([session]);
  const open = session.isOpen;
  return {
    status: session.status as 'active' | 'on_break' | 'completed',
    session: decorated,
    breaks: decorated.breaks,
    serverNow,
    targetMs: TARGET_MS,
    workedMs: decorated.workedMs,
    breakMs: decorated.breakMs,
    remainingMs: Math.max(0, TARGET_MS - decorated.workedMs),
    updatesToday: decorated.updatesCount,
    updateDue: open && !!session.nextUpdateDue && session.nextUpdateDue <= serverNow,
    nextUpdateDue: open ? session.nextUpdateDue ?? null : null,
  };
}

/**
 * Atomically close a session (manual end or auto-close of a stale one).
 * Returns null when somebody else already closed it => callers treat as "duplicate logout".
 */
export async function finalizeSession(sessionId: Types.ObjectId | string, endTime: Date, auto = false) {
  const claimed = await WorkSession.findOneAndUpdate(
    { _id: sessionId, isOpen: true },
    { $set: { isOpen: false, status: 'completed', endTime, autoClosed: auto } },
    { new: true },
  );
  if (!claimed) return null;

  // close any running break at the same instant
  await BreakRecord.updateMany({ session: claimed._id, open: true }, [
    {
      $set: {
        open: false,
        endTime,
        durationMs: { $max: [0, { $subtract: [endTime, '$startTime'] }] },
      },
    },
  ], { updatePipeline: true });

  const breaks = await BreakRecord.find({ session: claimed._id }).lean();
  const { workedMs, breakMs } = totalsFor({ startTime: claimed.startTime, endTime }, breaks);
  claimed.workedMs = workedMs;
  claimed.breakMs = breakMs;
  await claimed.save();
  await upsertAttendance(claimed.toObject());
  return claimed;
}

export async function upsertAttendance(s: {
  _id: any;
  employee: any;
  date: string;
  startTime: Date;
  endTime?: Date | null;
  workedMs?: number | null;
  breakMs?: number | null;
  isOpen?: boolean;
}) {
  await Attendance.findOneAndUpdate(
    { employee: s.employee, date: s.date },
    {
      $set: {
        session: s._id,
        status: attendanceStatus(s.workedMs ?? 0, !!s.isOpen),
        firstStart: s.startTime,
        lastEnd: s.endTime ?? undefined,
        workedMs: s.workedMs ?? 0,
        breakMs: s.breakMs ?? 0,
      },
    },
    { upsert: true },
  );
}

export const nextDueFrom = (from: Date) => new Date(+from + UPDATE_INTERVAL_MS);
