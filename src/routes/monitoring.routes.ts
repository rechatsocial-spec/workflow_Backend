import { Router } from 'express';
import { z } from 'zod';
import { UPDATE_INTERVAL_MS } from '../config/env';
import { authenticate, requireAdmin } from '../middleware/auth';
import { Employee } from '../models/employee.model';
import { WorkSession } from '../models/workSession.model';
import { WorkUpdate } from '../models/workUpdate.model';
import { decorateSessions } from '../services/session.service';
import { asyncHandler, dateStr, objectId, pageMeta, pageQuery, validate } from '../utils/http';
import { dateKey } from '../utils/time';

const router = Router();
router.use(authenticate, requireAdmin);

/** Login/logout records, working hours, breaks – filter by employee + date */
router.get(
  '/sessions',
  validate({ query: pageQuery.extend({ employeeId: objectId.optional(), from: dateStr.optional(), to: dateStr.optional(), status: z.enum(['active', 'on_break', 'completed']).optional() }) }),
  asyncHandler(async (req, res) => {
    const { page, limit, employeeId, from, to, status } = req.query as any;
    const filter: Record<string, any> = {};
    if (employeeId) filter.employee = employeeId;
    if (status) filter.status = status;
    if (from || to) filter.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
    const [total, rows] = await Promise.all([
      WorkSession.countDocuments(filter),
      WorkSession.find(filter)
        .sort({ date: -1, startTime: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('employee', 'name employeeId department')
        .lean(),
    ]);
    res.json({ items: await decorateSessions(rows), ...pageMeta(total, page, limit) });
  }),
);

/** Who is working / on break / not started right now */
router.get(
  '/live',
  asyncHandler(async (_req, res) => {
    const today = dateKey();
    const [employees, open, todays] = await Promise.all([
      Employee.find({ isActive: true }).select('name employeeId department designation').lean(),
      WorkSession.find({ isOpen: true }).lean(),
      WorkSession.find({ date: today }).lean(),
    ]);
    const openMap = new Map(open.map((s) => [String(s.employee), s]));
    const todayMap = new Map(todays.map((s) => [String(s.employee), s]));
    const decorated = await decorateSessions([...openMap.values()]);
    const dMap = new Map(decorated.map((s) => [String(s.employee), s]));
    const rows = employees.map((e) => {
      const s = dMap.get(String(e._id));
      const done = todayMap.get(String(e._id));
      return {
        employee: e,
        status: s ? s.status : done ? 'completed' : 'not_started',
        startTime: s?.startTime ?? done?.startTime ?? null,
        workedMs: s?.workedMs ?? done?.workedMs ?? 0,
        breakMs: s?.breakMs ?? done?.breakMs ?? 0,
        lastHeartbeat: s?.lastHeartbeat ?? null,
        nextUpdateDue: s?.nextUpdateDue ?? null,
        updatesCount: s?.updatesCount ?? 0,
      };
    });
    res.json({
      date: today,
      counts: {
        working: rows.filter((r) => r.status === 'active').length,
        onBreak: rows.filter((r) => r.status === 'on_break').length,
        completed: rows.filter((r) => r.status === 'completed').length,
        notStarted: rows.filter((r) => r.status === 'not_started').length,
      },
      rows,
    });
  }),
);

/**
 * Employees who owe updates: expected = floor(elapsed / interval); missing = expected - submitted.
 * `overdue` = session currently open and the next update is already past due.
 */
router.get(
  '/missing-updates',
  validate({ query: z.object({ date: dateStr.optional() }) }),
  asyncHandler(async (req, res) => {
    const date = (req.query as any).date ?? dateKey();
    const sessions = await WorkSession.find({ date }).populate('employee', 'name employeeId department').lean();
    const counts = await WorkUpdate.aggregate([
      { $match: { session: { $in: sessions.map((s) => s._id) } } },
      { $group: { _id: '$session', n: { $sum: 1 }, last: { $max: '$submittedAt' } } },
    ]);
    const cMap = new Map(counts.map((c) => [String(c._id), c]));
    const now = new Date();
    const rows = sessions
      .map((s) => {
        const end = s.endTime ?? now;
        const expected = Math.floor((+end - +s.startTime) / UPDATE_INTERVAL_MS);
        const c = cMap.get(String(s._id));
        const submitted = c?.n ?? 0;
        return {
          sessionId: s._id,
          employee: s.employee,
          date,
          startTime: s.startTime,
          expected,
          submitted,
          missing: Math.max(0, expected - submitted),
          lastUpdateAt: c?.last ?? null,
          overdue: s.isOpen && !!s.nextUpdateDue && s.nextUpdateDue <= now,
          nextUpdateDue: s.nextUpdateDue ?? null,
        };
      })
      .filter((r) => r.missing > 0 || r.overdue)
      .sort((a, b) => b.missing - a.missing);
    res.json({ date, items: rows });
  }),
);

export default router;
void pageMeta;
