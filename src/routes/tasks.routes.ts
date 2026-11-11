import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAdmin } from '../middleware/auth';
import { Employee } from '../models/employee.model';
import { PRIORITIES, TASK_STATUSES, Task } from '../models/task.model';
import { audit } from '../services/audit.service';
import { notifyUser } from '../services/notification.service';
import { ApiError, asyncHandler, escapeRegex, idParam, objectId, pageMeta, pageQuery, validate } from '../utils/http';

const router = Router();
router.use(authenticate);

const taskBody = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(5000).default(''),
  assignedTo: objectId,
  assignedDate: z.coerce.date().optional(),
  deadline: z.coerce.date(),
  priority: z.enum(PRIORITIES).default('medium'),
  status: z.enum(TASK_STATUSES).default('pending'),
});

const populateTask = (q: any) => q.populate('assignedTo', 'name employeeId department');

/** Admin: every task. Employee: only their own (read-only). */
router.get(
  '/',
  validate({
    query: pageQuery.extend({
      q: z.string().trim().optional(),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(PRIORITIES).optional(),
      employeeId: objectId.optional(),
      sort: z.enum(['deadline', '-deadline', '-createdAt', 'priority']).default('-createdAt'),
      all: z.enum(['true', 'false']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, status, priority, employeeId, sort, all } = req.query as any;
    const filter: Record<string, any> = {};
    if (req.user!.role === 'employee') {
      const me = await Employee.findOne({ user: req.user!.id }).select('_id').lean();
      if (!me) throw new ApiError(403, 'Employee profile not found');
      filter.assignedTo = me._id;
    } else if (employeeId) filter.assignedTo = employeeId;
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (q) filter.title = new RegExp(escapeRegex(q), 'i');

    const total = await Task.countDocuments(filter);
    let query = populateTask(Task.find(filter));
    if (sort === 'priority') {
      // custom order urgent > high > medium > low handled after fetch for the page window
      query = query.sort({ deadline: 1 });
    } else query = query.sort(sort === 'deadline' ? { deadline: 1 } : sort === '-deadline' ? { deadline: -1 } : { createdAt: -1 });
    let items = await (all === 'true' ? query.limit(500) : query.skip((page - 1) * limit).limit(limit)).lean();
    if (sort === 'priority') {
      const w: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
      items = items.sort((a: any, b: any) => w[a.priority] - w[b.priority]);
    }
    res.json({ items, ...pageMeta(total, page, limit) });
  }),
);

router.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const task: any = await populateTask(Task.findById(req.params.id)).lean();
    if (!task) throw new ApiError(404, 'Task not found');
    if (req.user!.role === 'employee') {
      const me = await Employee.findOne({ user: req.user!.id }).select('_id').lean();
      if (!me || String(task.assignedTo._id) !== String(me._id)) throw new ApiError(403, 'Not your task');
    }
    res.json({ task });
  }),
);

router.post(
  '/',
  requireAdmin,
  validate({ body: taskBody }),
  asyncHandler(async (req, res) => {
    const emp = await Employee.findById(req.body.assignedTo);
    if (!emp || !emp.isActive) throw new ApiError(400, 'Assignee not found or inactive');
    const task = await Task.create({
      ...req.body,
      assignedBy: req.user!.id,
      assignedDate: req.body.assignedDate ?? new Date(),
      progress: req.body.status === 'completed' ? 100 : 0,
      completedAt: req.body.status === 'completed' ? new Date() : undefined,
    });
    await notifyUser(emp.user, {
      type: 'task_assigned',
      title: 'New task assigned',
      message: `"${task.title}" — due ${task.deadline.toLocaleString()} (${task.priority} priority)`,
      link: '/employee/tasks',
      data: { taskId: task.id },
    });
    await audit({ req, action: 'TASK_CREATED', entityType: 'Task', entityId: task._id, metadata: { assignedTo: emp.employeeId, title: task.title } });
    res.status(201).json({ task: await populateTask(Task.findById(task._id)).lean() });
  }),
);

router.patch(
  '/:id',
  requireAdmin,
  validate({ params: idParam, body: taskBody.partial() }),
  asyncHandler(async (req, res) => {
    const task = await Task.findById(req.params.id);
    if (!task) throw new ApiError(404, 'Task not found');
    const prevDeadline = +task.deadline;
    const prevAssignee = String(task.assignedTo);
    if (req.body.assignedTo) {
      const emp = await Employee.findById(req.body.assignedTo);
      if (!emp || !emp.isActive) throw new ApiError(400, 'Assignee not found or inactive');
    }
    task.set(req.body);
    if (req.body.deadline && +task.deadline !== prevDeadline) task.deadlineNotified = false;
    if (req.body.status) {
      if (req.body.status === 'completed') {
        task.progress = 100;
        task.completedAt = task.completedAt ?? new Date();
      } else {
        task.completedAt = undefined;
        if (req.body.status === 'pending') task.progress = 0;
      }
    }
    await task.save();
    const emp = await Employee.findById(task.assignedTo).select('user').lean();
    if (emp) {
      const reassigned = String(task.assignedTo) !== prevAssignee;
      await notifyUser(emp.user, {
        type: reassigned ? 'task_assigned' : 'task_updated',
        title: reassigned ? 'New task assigned' : 'Task updated',
        message: `"${task.title}" was ${reassigned ? 'assigned to you' : 'updated by admin'}`,
        link: '/employee/tasks',
      });
    }
    await audit({ req, action: 'TASK_UPDATED', entityType: 'Task', entityId: task._id, metadata: { fields: Object.keys(req.body) } });
    res.json({ task: await populateTask(Task.findById(task._id)).lean() });
  }),
);

router.delete(
  '/:id',
  requireAdmin,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) throw new ApiError(404, 'Task not found');
    await audit({ req, action: 'TASK_DELETED', entityType: 'Task', entityId: task._id, metadata: { title: task.title } });
    res.json({ message: 'Task deleted' });
  }),
);

export default router;
