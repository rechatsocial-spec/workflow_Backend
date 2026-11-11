import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAdmin } from '../middleware/auth';
import { Attendance } from '../models/attendance.model';
import { Employee } from '../models/employee.model';
import { Task } from '../models/task.model';
import { WorkSession } from '../models/workSession.model';
import { decorateSessions } from '../services/session.service';
import { asyncHandler, dateStr, objectId, validate } from '../utils/http';
import { daysBetween, dateKey, hoursOf, isWeekend, monthDays, weekStart } from '../utils/time';

const router = Router();
router.use(authenticate, requireAdmin);

function resolveRange(range: string, from?: string, to?: string) {
  const today = dateKey();
  if (range === 'today') return { from: today, to: today };
  if (range === 'week') return { from: weekStart(today), to: today };
  if (range === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  const f = from ?? today;
  const t = to ?? today;
  return f <= t ? { from: f, to: t } : { from: t, to: f };
}

router.get(
  '/overview',
  validate({
    query: z.object({
      range: z.enum(['today', 'week', 'month', 'custom']).default('today'),
      from: dateStr.optional(),
      to: dateStr.optional(),
      employeeId: objectId.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { range, from: f, to: t, employeeId } = req.query as any;
    const { from, to } = resolveRange(range, f, t);
    const today = dateKey();
    const empFilter = employeeId ? { _id: employeeId } : {};
    const sessFilter: Record<string, any> = { date: { $gte: from, $lte: to } };
    const taskFilter: Record<string, any> = { assignedDate: { $gte: new Date(`${from}T00:00:00.000Z`), $lte: new Date(`${to}T23:59:59.999Z`) } };
    if (employeeId) {
      sessFilter.employee = employeeId;
      taskFilter.assignedTo = employeeId;
    }

    const [totalEmployees, activeEmployees, openSessions, sessions, taskAgg, activeIds] = await Promise.all([
      Employee.countDocuments(empFilter),
      Employee.countDocuments({ ...empFilter, isActive: true }),
      WorkSession.find({ isOpen: true, ...(employeeId ? { employee: employeeId } : {}) }).select('status').lean(),
      WorkSession.find(sessFilter).populate('employee', 'name employeeId').lean(),
      Task.aggregate([{ $match: taskFilter }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      Employee.find({ ...empFilter, isActive: true }).distinct('_id'),
    ]);

    const decorated = await decorateSessions(sessions);
    const totalWorkedMs = decorated.reduce((s, d) => s + d.workedMs, 0);
    const totalBreakMs = decorated.reduce((s, d) => s + d.breakMs, 0);

    const tasks = { pending: 0, in_progress: 0, completed: 0 } as Record<string, number>;
    taskAgg.forEach((a) => (tasks[a._id] = a.n));
    const tasksAssigned = tasks.pending + tasks.in_progress + tasks.completed;

    // attendance % = employee-days attended / employee-days expected (Mon–Fri up to today)
    const days = daysBetween(from, to < today ? to : today);
    const workDays = days.filter((d) => !isWeekend(d));
    const expectedDays = workDays.length * activeIds.length;
    const attended = await Attendance.countDocuments({
      date: { $in: workDays },
      employee: { $in: activeIds },
    });
    const attendancePct = expectedDays ? Math.min(100, Math.round((attended / expectedDays) * 1000) / 10) : 0;

    // charts
    const byDate = new Map<string, { ms: number; people: Set<string> }>();
    decorated.forEach((d) => {
      const e = byDate.get(d.date) ?? { ms: 0, people: new Set() };
      e.ms += d.workedMs;
      e.people.add(String((d.employee as any)?._id ?? d.employee));
      byDate.set(d.date, e);
    });
    const chartDays = days.length > 62 ? days.filter((_, i) => i % Math.ceil(days.length / 62) === 0) : days;
    const dailyHours = chartDays.map((d) => ({ date: d, hours: hoursOf(byDate.get(d)?.ms ?? 0), employees: byDate.get(d)?.people.size ?? 0 }));

    const perEmp = new Map<string, { name: string; ms: number }>();
    decorated.forEach((d: any) => {
      const key = String(d.employee?._id);
      const e = perEmp.get(key) ?? { name: d.employee?.name ?? 'Unknown', ms: 0 };
      e.ms += d.workedMs;
      perEmp.set(key, e);
    });
    const topEmployees = [...perEmp.values()].sort((a, b) => b.ms - a.ms).slice(0, 8).map((e) => ({ name: e.name, hours: hoursOf(e.ms) }));

    const attAgg = await Attendance.aggregate([
      { $match: { date: { $in: workDays }, employee: { $in: activeIds } } },
      { $group: { _id: '$date', n: { $sum: 1 } } },
    ]);
    const attMap = new Map(attAgg.map((a) => [a._id, a.n]));
    const attendanceTrend = workDays.slice(-62).map((d) => ({ date: d, present: attMap.get(d) ?? 0, expected: activeIds.length }));

    res.json({
      range: { from, to },
      cards: {
        totalEmployees,
        activeEmployees,
        currentlyWorking: openSessions.filter((s) => s.status === 'active').length,
        onBreak: openSessions.filter((s) => s.status === 'on_break').length,
        totalWorkedHours: hoursOf(totalWorkedMs),
        totalBreakHours: hoursOf(totalBreakMs),
        averageWorkedHours: decorated.length ? hoursOf(totalWorkedMs / decorated.length) : 0,
        tasksAssigned,
        tasksCompleted: tasks.completed,
        tasksPending: tasks.pending + tasks.in_progress,
        attendancePct,
      },
      charts: {
        dailyHours,
        taskStatus: [
          { name: 'Pending', value: tasks.pending },
          { name: 'In progress', value: tasks.in_progress },
          { name: 'Completed', value: tasks.completed },
        ],
        topEmployees,
        attendanceTrend,
      },
    });
  }),
);

export default router;
void monthDays;
