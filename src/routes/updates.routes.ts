import { Router } from 'express';
import { z } from 'zod';
import { authenticate, loadEmployee } from '../middleware/auth';
import { Employee } from '../models/employee.model';
import { Task } from '../models/task.model';
import { WorkSession } from '../models/workSession.model';
import { WorkUpdate } from '../models/workUpdate.model';
import { audit } from '../services/audit.service';
import { notifyAdmins, pingMonitor } from '../services/notification.service';
import { nextDueFrom } from '../services/session.service';
import { ApiError, asyncHandler, dateStr, objectId, pageMeta, pageQuery, validate } from '../utils/http';
import { dateKey } from '../utils/time';

const router = Router();
router.use(authenticate);

const submitBody = z.object({
  taskId: objectId.optional(),
  completedWork: z.string().trim().min(5, 'Describe the work completed').max(5000),
  progress: z.coerce.number().int().min(0).max(100),
  pendingWork: z.string().trim().min(2, 'Describe the pending work').max(5000),
  challenges: z.string().trim().max(5000).optional().default(''),
});

router.post(
  '/',
  loadEmployee,
  validate({ body: submitBody }),
  asyncHandler(async (req, res) => {
    const emp = req.employee!;
    const session = await WorkSession.findOne({ employee: emp._id, isOpen: true });
    if (!session) throw new ApiError(409, 'Start a work session before submitting updates');

    let task = null;
    if (req.body.taskId) {
      task = await Task.findOne({ _id: req.body.taskId, assignedTo: emp._id }); // can only report on OWN tasks
      if (!task) throw new ApiError(404, 'Task not found');
    }

    const now = new Date();
    const update = await WorkUpdate.create({
      session: session._id,
      employee: emp._id,
      task: task?._id,
      date: dateKey(now),
      completedWork: req.body.completedWork,
      progress: req.body.progress,
      pendingWork: req.body.pendingWork,
      challenges: req.body.challenges,
      submittedAt: now,
    });

    // restart the 2-hour clock, clear reminder flags
    await WorkSession.updateOne(
      { _id: session._id },
      { $set: { nextUpdateDue: nextDueFrom(now), reminderSent: false, missedNotified: false, lastHeartbeat: now } },
    );

    // progress reported by the employee drives task status (employee never edits the task itself)
    if (task) {
      const wasCompleted = task.status === 'completed';
      task.progress = req.body.progress;
      if (req.body.progress >= 100) {
        task.status = 'completed';
        task.completedAt = now;
      } else {
        task.status = req.body.progress > 0 ? 'in_progress' : task.status;
        task.completedAt = undefined;
      }
      await task.save();
      if (task.status === 'completed' && !wasCompleted) {
        await notifyAdmins({
          type: 'task_completed',
          title: 'Task completed',
          message: `${emp.name} completed "${task.title}"`,
          link: '/admin/tasks',
        });
      }
    }

    await audit({ req, action: 'UPDATE_SUBMITTED', entityType: 'WorkUpdate', entityId: update._id, metadata: { taskId: task?.id, progress: req.body.progress } });
    pingMonitor();
    res.status(201).json({ update, nextUpdateDue: nextDueFrom(now) });
  }),
);

/** Employee: own history. Admin: everything, filterable. */
router.get(
  '/',
  validate({
    query: pageQuery.extend({
      employeeId: objectId.optional(),
      taskId: objectId.optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { page, limit, employeeId, taskId, from, to } = req.query as any;
    const filter: Record<string, any> = {};
    if (req.user!.role === 'employee') {
      const me = await Employee.findOne({ user: req.user!.id }).select('_id').lean();
      if (!me) throw new ApiError(403, 'Employee profile not found');
      filter.employee = me._id;
    } else if (employeeId) filter.employee = employeeId;
    if (taskId) filter.task = taskId;
    if (from || to) filter.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };

    const [total, items] = await Promise.all([
      WorkUpdate.countDocuments(filter),
      WorkUpdate.find(filter)
        .sort({ submittedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('employee', 'name employeeId department')
        .populate('task', 'title priority')
        .lean(),
    ]);
    res.json({ items, ...pageMeta(total, page, limit) });
  }),
);

export default router;
