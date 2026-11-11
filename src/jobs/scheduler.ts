import cron from 'node-cron';
import { env, UPDATE_GRACE_MS } from '../config/env';
import { Attendance } from '../models/attendance.model';
import { Employee } from '../models/employee.model';
import { Notification } from '../models/notification.model';
import { Task } from '../models/task.model';
import { WorkSession } from '../models/workSession.model';
import { notifyAdmins, notifyUser } from '../services/notification.service';
import { finalizeSession } from '../services/session.service';
import { dateKey, isWeekend, timeLabel } from '../utils/time';

/**
 * Every claim below is an atomic findOneAndUpdate on a boolean flag, so even if the
 * server runs several instances a reminder/alert fires exactly once.
 */

async function updateReminders() {
  const now = new Date();
  // 1) reminder to the employee as soon as the update is due
  const due = await WorkSession.find({ isOpen: true, status: 'active', reminderSent: false, nextUpdateDue: { $lte: now } }).populate<{ employee: any }>('employee', 'name employeeId user').lean();
  for (const s of due) {
    const claimed = await WorkSession.findOneAndUpdate({ _id: s._id, reminderSent: false }, { reminderSent: true });
    if (!claimed) continue;
    await notifyUser(s.employee.user, {
      type: 'update_reminder',
      title: 'Work update due',
      message: 'Your 2-hour progress update is due. Please submit it now.',
      link: '/employee/updates',
    });
  }
  // 2) escalate to admins once the grace period has passed
  const late = await WorkSession.find({
    isOpen: true,
    status: 'active',
    missedNotified: false,
    nextUpdateDue: { $lte: new Date(+now - UPDATE_GRACE_MS) },
  }).populate<{ employee: any }>('employee', 'name employeeId').lean();
  for (const s of late) {
    const claimed = await WorkSession.findOneAndUpdate({ _id: s._id, missedNotified: false }, { missedNotified: true });
    if (!claimed) continue;
    await notifyAdmins({
      type: 'missing_update',
      title: 'Missing work update',
      message: `${s.employee.name} (${s.employee.employeeId}) has not submitted the update due at ${timeLabel(s.nextUpdateDue)}.`,
      link: '/admin/monitoring',
    });
  }
}

async function breakReminders() {
  if (!env.BREAK_REMINDER_MINUTES) return;
  const cutoff = new Date(Date.now() - env.BREAK_REMINDER_MINUTES * 60_000);
  const rows = await WorkSession.find({ isOpen: true, status: 'active', breakReminderSent: false, segmentStart: { $lte: cutoff } }).populate<{ employee: any }>('employee', 'user').lean();
  for (const s of rows) {
    const claimed = await WorkSession.findOneAndUpdate({ _id: s._id, breakReminderSent: false }, { breakReminderSent: true });
    if (!claimed) continue;
    await notifyUser(s.employee.user, {
      type: 'break_reminder',
      title: 'Time for a break?',
      message: `You have been working for ${env.BREAK_REMINDER_MINUTES} minutes without a break.`,
    });
  }
}

async function deadlineReminders() {
  const now = new Date();
  const horizon = new Date(+now + env.DEADLINE_WARNING_HOURS * 3_600_000);
  const tasks = await Task.find({ status: { $ne: 'completed' }, deadlineNotified: false, deadline: { $gt: now, $lte: horizon } }).populate<{ assignedTo: any }>('assignedTo', 'user').lean();
  for (const t of tasks) {
    const claimed = await Task.findOneAndUpdate({ _id: t._id, deadlineNotified: false }, { deadlineNotified: true });
    if (!claimed) continue;
    await notifyUser(t.assignedTo.user, {
      type: 'deadline_approaching',
      title: 'Deadline approaching',
      message: `"${t.title}" is due ${t.deadline.toLocaleString()}`,
      link: '/employee/tasks',
    });
  }
}

/** A session still open from an earlier day (forgot to press End Work / crashed) is closed at its last heartbeat */
async function closeStaleSessions() {
  const stale = await WorkSession.find({ isOpen: true, date: { $lt: dateKey() } }).lean();
  for (const s of stale) {
    const end = new Date(Math.max(+(s.lastHeartbeat ?? s.startTime), +s.startTime));
    await finalizeSession(s._id, end, true);
    console.log(`[scheduler] auto-closed stale session ${s._id}`);
  }
}

async function dailyAttendanceSummary() {
  const today = dateKey();
  if (isWeekend(today)) return;
  const exists = await Notification.exists({ type: 'attendance_summary', 'data.date': today });
  if (exists) return;
  const [active, present, late] = await Promise.all([
    Employee.countDocuments({ isActive: true }),
    Attendance.countDocuments({ date: today }),
    WorkSession.countDocuments({ date: today, missedNotified: true }),
  ]);
  await notifyAdmins({
    type: 'attendance_summary',
    title: `Attendance summary — ${today}`,
    message: `${present} of ${active} active employees worked today (${Math.max(0, active - present)} absent). ${late} session(s) had missing updates.`,
    link: '/admin/monitoring',
    data: { date: today },
  });
}

const safe = (name: string, fn: () => Promise<void>) => async () => {
  try {
    await fn();
  } catch (e) {
    console.error(`[scheduler:${name}]`, e);
  }
};

export function startScheduler() {
  if (env.DISABLE_SCHEDULER) return [];
  const tasks = [
    cron.schedule('* * * * *', safe('updates', updateReminders)),
    cron.schedule('* * * * *', safe('break', breakReminders)),
    cron.schedule('*/10 * * * *', safe('deadlines', deadlineReminders)),
    cron.schedule('*/10 * * * *', safe('stale', closeStaleSessions)),
    cron.schedule('30 23 * * *', safe('summary', dailyAttendanceSummary), { timezone: env.APP_TIMEZONE }),
  ];
  // recover immediately after a restart
  void safe('stale', closeStaleSessions)();
  console.log('[scheduler] started');
  return tasks;
}

export const _test = { updateReminders, deadlineReminders, closeStaleSessions, dailyAttendanceSummary };
