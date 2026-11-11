import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { authenticate, loadEmployee } from '../middleware/auth';
import { BreakRecord } from '../models/breakRecord.model';
import { WorkSession } from '../models/workSession.model';
import { audit } from '../services/audit.service';
import { notifyAdmins, notifyUser, pingMonitor } from '../services/notification.service';
import { decorateSessions, finalizeSession, getTodayState, nextDueFrom, upsertAttendance } from '../services/session.service';
import { ApiError, asyncHandler, dateStr, pageMeta, pageQuery, validate } from '../utils/http';
import { dateKey, fmtDuration, timeLabel } from '../utils/time';

const router = Router();
router.use(authenticate, loadEmployee);

router.get(
  '/today',
  asyncHandler(async (req, res) => {
    res.json(await getTodayState(req.employee!._id));
  }),
);

/** Start Work — creates the one-and-only session of the day */
router.post(
  '/start',
  asyncHandler(async (req, res) => {
    const emp = req.employee!;
    const now = new Date();
    const date = dateKey(now);

    const existing = await WorkSession.findOne({ employee: emp._id, $or: [{ isOpen: true }, { date }] }).lean();
    if (existing) {
      throw new ApiError(409, existing.isOpen ? 'You already have an active work session' : 'Your work session for today has already been completed', {
        state: await getTodayState(emp._id),
      });
    }

    let session;
    try {
      session = await WorkSession.create({
        employee: emp._id,
        date,
        startTime: now,
        lastHeartbeat: now,
        segmentStart: now,
        nextUpdateDue: nextDueFrom(now),
      });
    } catch (e: any) {
      // unique indexes caught a concurrent double-click / second device
      if (e?.code === 11000) throw new ApiError(409, 'A work session is already active', { state: await getTodayState(emp._id) });
      throw e;
    }
    await upsertAttendance(session.toObject());

    await notifyUser(req.user!.id, {
      type: 'work_started',
      title: 'Work session started',
      message: `Your session started at ${timeLabel(now)}. Next update due at ${timeLabel(session.nextUpdateDue)}.`,
    });
    await notifyAdmins({ type: 'work_started', title: 'Employee logged in', message: `${emp.name} (${emp.employeeId}) started work at ${timeLabel(now)}`, link: '/admin/monitoring' });
    await audit({ req, action: 'WORK_STARTED', entityType: 'WorkSession', entityId: session._id });
    pingMonitor();
    res.status(201).json(await getTodayState(emp._id));
  }),
);

router.post(
  '/break/start',
  asyncHandler(async (req, res) => {
    const emp = req.employee!;
    const now = new Date();
    // atomic state transition: only an ACTIVE session can go on break
    const session = await WorkSession.findOneAndUpdate({ employee: emp._id, isOpen: true, status: 'active' }, { $set: { status: 'on_break', lastHeartbeat: now } }, { new: true });
    if (!session) {
      const cur = await WorkSession.findOne({ employee: emp._id, isOpen: true }).lean();
      throw new ApiError(409, cur ? 'You are already on a break' : 'Start your work session first');
    }
    try {
      await BreakRecord.create({ session: session._id, employee: emp._id, date: session.date, startTime: now });
    } catch (e: any) {
      await WorkSession.updateOne({ _id: session._id }, { status: 'active' });
      if (e?.code === 11000) throw new ApiError(409, 'A break is already running');
      throw e;
    }
    await audit({ req, action: 'BREAK_STARTED', entityType: 'WorkSession', entityId: session._id });
    pingMonitor();
    res.json(await getTodayState(emp._id));
  }),
);

router.post(
  '/break/end',
  asyncHandler(async (req, res) => {
    const emp = req.employee!;
    const now = new Date();
    const session = await WorkSession.findOne({ employee: emp._id, isOpen: true, status: 'on_break' });
    if (!session) throw new ApiError(409, 'You are not on a break');

    const brk = await BreakRecord.findOneAndUpdate(
      { session: session._id, open: true },
      [{ $set: { open: false, endTime: now, durationMs: { $max: [0, { $subtract: [now, '$startTime'] }] } } }],
      { new: true, updatePipeline: true },
    );
    if (!brk) throw new ApiError(409, 'Break already ended');

    await WorkSession.updateOne(
      { _id: session._id, isOpen: true },
      { $set: { status: 'active', lastHeartbeat: now, segmentStart: now, breakReminderSent: false } },
    );
    await audit({ req, action: 'BREAK_ENDED', entityType: 'WorkSession', entityId: session._id, metadata: { durationMs: brk.durationMs } });
    pingMonitor();
    res.json(await getTodayState(emp._id));
  }),
);

/** End Work — idempotent-safe: a 2nd click gets a clear 409, never a 2nd logout */
router.post(
  '/end',
  asyncHandler(async (req, res) => {
    const emp = req.employee!;
    const open = await WorkSession.findOne({ employee: emp._id, isOpen: true }).select('_id').lean();
    if (!open) {
      const today = await WorkSession.findOne({ employee: emp._id, date: dateKey() }).lean();
      throw new ApiError(409, today ? 'You have already ended work for today' : 'No active work session to end', { state: await getTodayState(emp._id) });
    }
    const ended = await finalizeSession(open._id, new Date());
    if (!ended) throw new ApiError(409, 'You have already ended work for today', { state: await getTodayState(emp._id) });

    await notifyAdmins({
      type: 'work_ended',
      title: 'Employee logged out',
      message: `${emp.name} (${emp.employeeId}) ended work. Worked ${fmtDuration(ended.workedMs)}, break ${fmtDuration(ended.breakMs)}.`,
      link: '/admin/monitoring',
    });
    await notifyUser(req.user!.id, {
      type: 'work_ended',
      title: 'Work session ended',
      message: `Today: worked ${fmtDuration(ended.workedMs)} (target ${env.DAILY_TARGET_HOURS}h), break ${fmtDuration(ended.breakMs)}.`,
    });
    await audit({ req, action: 'WORK_ENDED', entityType: 'WorkSession', entityId: ended._id, metadata: { workedMs: ended.workedMs, breakMs: ended.breakMs } });
    pingMonitor();
    res.json(await getTodayState(emp._id));
  }),
);

/** Called every minute + on reconnect by the client; also the "session recovery" endpoint */
router.post(
  '/heartbeat',
  asyncHandler(async (req, res) => {
    await WorkSession.updateOne({ employee: req.employee!._id, isOpen: true }, { $set: { lastHeartbeat: new Date() } });
    res.json(await getTodayState(req.employee!._id));
  }),
);

/** Own history (read-only: employees can never edit or delete attendance) */
router.get(
  '/history',
  validate({ query: pageQuery.extend({ from: dateStr.optional(), to: dateStr.optional() }) }),
  asyncHandler(async (req, res) => {
    const { page, limit, from, to } = req.query as any;
    const filter: Record<string, any> = { employee: req.employee!._id };
    if (from || to) filter.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
    const [total, rows] = await Promise.all([
      WorkSession.countDocuments(filter),
      WorkSession.find(filter).sort({ date: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    res.json({ items: await decorateSessions(rows), ...pageMeta(total, page, limit) });
  }),
);

export default router;

void z; // (z reserved for future body schemas)
