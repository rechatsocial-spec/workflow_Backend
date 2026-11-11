import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAdmin } from '../middleware/auth';
import { Employee, nextEmployeeId } from '../models/employee.model';
import { Task } from '../models/task.model';
import { User } from '../models/user.model';
import { WorkSession } from '../models/workSession.model';
import { audit } from '../services/audit.service';
import { sendMail } from '../services/mailer.service';
import { decorateSessions } from '../services/session.service';
import { ApiError, asyncHandler, escapeRegex, idParam, pageMeta, pageQuery, strongPassword, validate } from '../utils/http';
import { generatePassword, hashPassword } from '../utils/security';
import { dateKey, hoursOf } from '../utils/time';
import { env } from '../config/env';

const router = Router();
router.use(authenticate, requireAdmin);

const employeeFields = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().email().toLowerCase().trim(),
  phone: z.string().trim().max(30).optional(),
  designation: z.string().trim().min(2).max(100),
  department: z.string().trim().min(2).max(100),
  joiningDate: z.coerce.date(),
});

// admin may choose ANY simple password (min 4 chars); blank = auto-generate a strong one
const adminPassword = z.string().min(4, 'Min 4 characters').max(100);
const createBody = employeeFields.extend({ password: adminPassword.optional(), mustChangePassword: z.boolean().default(true) });
const updateBody = employeeFields.partial();

const shape = (e: any) => ({
  id: String(e._id),
  employeeId: e.employeeId,
  name: e.name,
  email: e.user?.email,
  phone: e.phone,
  designation: e.designation,
  department: e.department,
  joiningDate: e.joiningDate,
  isActive: e.isActive,
  lastLoginAt: e.user?.lastLoginAt,
  createdAt: e.createdAt,
});

async function emailCredentials(name: string, email: string, password: string) {
  await sendMail(
    email,
    'Your Work Management account',
    `<p>Hi ${name},</p><p>An account has been created for you.</p><p><b>Login:</b> ${env.CLIENT_URL}/login<br/><b>Email:</b> ${email}<br/><b>Temporary password:</b> ${password}</p><p>You will be asked to change your password on first login.</p>`,
  );
}

router.post(
  '/',
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const { password: given, mustChangePassword, ...data } = req.body as z.infer<typeof createBody>;
    if (await User.exists({ email: data.email })) throw new ApiError(409, 'An account with this email already exists');

    const password = given ?? generatePassword();
    const user = await User.create({
      email: data.email,
      name: data.name,
      role: 'employee',
      passwordHash: await hashPassword(password),
      mustChangePassword,
    });
    try {
      const employee = await Employee.create({
        user: user._id,
        employeeId: await nextEmployeeId(),
        name: data.name,
        phone: data.phone,
        designation: data.designation,
        department: data.department,
        joiningDate: data.joiningDate,
      });
      await audit({ req, action: 'EMPLOYEE_CREATED', entityType: 'Employee', entityId: employee._id, metadata: { email: data.email, employeeId: employee.employeeId } });
      void emailCredentials(data.name, data.email, password);
      res.status(201).json({
        employee: shape({ ...employee.toObject(), user: user.toObject() }),
        // shown exactly once, never stored in plain text
        credentials: { email: data.email, password },
      });
    } catch (e) {
      await User.deleteOne({ _id: user._id }); // roll back orphan user
      throw e;
    }
  }),
);

router.get(
  '/meta/departments',
  asyncHandler(async (_req, res) => {
    res.json({ departments: (await Employee.distinct('department')).sort() });
  }),
);

router.get(
  '/',
  validate({
    query: pageQuery.extend({
      q: z.string().trim().optional(),
      status: z.enum(['active', 'inactive']).optional(),
      department: z.string().trim().optional(),
      all: z.enum(['true', 'false']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, status, department, all } = req.query as any;
    const filter: Record<string, any> = {};
    if (status) filter.isActive = status === 'active';
    if (department) filter.department = department;
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      const userIds = await User.find({ email: rx, role: 'employee' }).distinct('_id');
      filter.$or = [{ name: rx }, { employeeId: rx }, { designation: rx }, { user: { $in: userIds } }];
    }
    const total = await Employee.countDocuments(filter);
    // `all=true` returns an unpaginated light list for dropdowns
    const q2 = Employee.find(filter).populate('user', 'email lastLoginAt').sort({ createdAt: -1 });
    const items = all === 'true' ? await q2.limit(1000) : await q2.skip((page - 1) * limit).limit(limit);
    res.json({ items: items.map(shape), ...pageMeta(total, page, limit) });
  }),
);

router.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const emp = await Employee.findById(req.params.id).populate('user', 'email lastLoginAt');
    if (!emp) throw new ApiError(404, 'Employee not found');
    const month = dateKey().slice(0, 7);
    const [taskAgg, sessions, openSession] = await Promise.all([
      Task.aggregate([{ $match: { assignedTo: emp._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      WorkSession.find({ employee: emp._id, date: { $gte: `${month}-01`, $lte: `${month}-31` } }).lean(),
      WorkSession.findOne({ employee: emp._id, isOpen: true }).lean(),
    ]);
    const decorated = await decorateSessions(sessions);
    const tasks = { pending: 0, in_progress: 0, completed: 0 } as Record<string, number>;
    taskAgg.forEach((t) => (tasks[t._id] = t.n));
    res.json({
      employee: shape(emp),
      stats: {
        tasks,
        daysWorkedThisMonth: sessions.length,
        hoursThisMonth: hoursOf(decorated.reduce((s, d) => s + d.workedMs, 0)),
        currentStatus: openSession?.status ?? 'offline',
      },
    });
  }),
);

router.patch(
  '/:id',
  validate({ params: idParam, body: updateBody }),
  asyncHandler(async (req, res) => {
    const emp = await Employee.findById(req.params.id);
    if (!emp) throw new ApiError(404, 'Employee not found');
    const { email, ...rest } = req.body as z.infer<typeof updateBody>;
    if (email) {
      const clash = await User.exists({ email, _id: { $ne: emp.user } });
      if (clash) throw new ApiError(409, 'Another account already uses this email');
      await User.updateOne({ _id: emp.user }, { email, ...(rest.name ? { name: rest.name } : {}) });
    } else if (rest.name) {
      await User.updateOne({ _id: emp.user }, { name: rest.name });
    }
    emp.set(rest);
    await emp.save();
    await audit({ req, action: 'EMPLOYEE_UPDATED', entityType: 'Employee', entityId: emp._id, metadata: { fields: Object.keys(req.body) } });
    await emp.populate('user', 'email lastLoginAt');
    res.json({ employee: shape(emp) });
  }),
);

router.patch(
  '/:id/status',
  validate({ params: idParam, body: z.object({ isActive: z.boolean() }) }),
  asyncHandler(async (req, res) => {
    const emp = await Employee.findById(req.params.id);
    if (!emp) throw new ApiError(404, 'Employee not found');
    emp.isActive = req.body.isActive;
    await emp.save();
    // deactivation also revokes every issued token
    await User.updateOne({ _id: emp.user }, { isActive: req.body.isActive, ...(req.body.isActive ? {} : { $inc: { tokenVersion: 1 } }) });
    await audit({ req, action: req.body.isActive ? 'EMPLOYEE_ACTIVATED' : 'EMPLOYEE_DEACTIVATED', entityType: 'Employee', entityId: emp._id });
    await emp.populate('user', 'email lastLoginAt');
    res.json({ employee: shape(emp) });
  }),
);

router.post(
  '/:id/reset-credentials',
  validate({ params: idParam, body: z.object({ password: adminPassword.optional(), mustChangePassword: z.boolean().default(true) }) }),
  asyncHandler(async (req, res) => {
    const emp = await Employee.findById(req.params.id).populate<{ user: any }>('user', 'email name');
    if (!emp) throw new ApiError(404, 'Employee not found');
    const password = req.body.password ?? generatePassword();
    await User.updateOne(
      { _id: emp.user._id },
      { passwordHash: await hashPassword(password), mustChangePassword: req.body.mustChangePassword, failedLogins: 0, lockUntil: null, $inc: { tokenVersion: 1 } },
    );
    await audit({ req, action: 'CREDENTIALS_RESET', entityType: 'Employee', entityId: emp._id });
    void emailCredentials(emp.name, emp.user.email, password);
    res.json({ credentials: { email: emp.user.email, password } });
  }),
);

export default router;
