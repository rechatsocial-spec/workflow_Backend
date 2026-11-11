import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { authenticate } from '../middleware/auth';
import { Employee } from '../models/employee.model';
import { User } from '../models/user.model';
import { audit } from '../services/audit.service';
import { sendMail } from '../services/mailer.service';
import { ApiError, asyncHandler, strongPassword, validate } from '../utils/http';
import { COOKIE_NAME, comparePassword, cookieOptions, hashPassword, randomToken, sha256, signToken } from '../utils/security';

const router = Router();
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

const loginBody = z.object({ email: z.string().email().toLowerCase().trim(), password: z.string().min(1).max(100) });

function loginHandler(role: 'admin' | 'employee') {
  return asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body as z.infer<typeof loginBody>;
    const user = await User.findOne({ email }).select('+passwordHash');
    const generic = new ApiError(401, 'Invalid email or password');

    // wrong portal is reported exactly like wrong credentials (no account enumeration)
    if (!user || user.role !== role) throw generic;
    if (user.lockUntil && user.lockUntil > new Date()) throw new ApiError(423, 'Too many failed attempts. Try again in a few minutes.');

    const ok = await comparePassword(password, user.passwordHash);
    if (!ok) {
      user.failedLogins = (user.failedLogins ?? 0) + 1;
      if (user.failedLogins >= MAX_FAILS) {
        user.lockUntil = new Date(Date.now() + LOCK_MS);
        user.failedLogins = 0;
      }
      await user.save();
      await audit({ req, actor: { id: user.id, email, role }, action: 'LOGIN_FAILED', entityType: 'User', entityId: user.id });
      throw generic;
    }
    if (!user.isActive) throw new ApiError(403, 'Your account is deactivated. Contact your administrator.');

    user.failedLogins = 0;
    user.lockUntil = undefined;
    user.lastLoginAt = new Date();
    await user.save();

    res.cookie(COOKIE_NAME, signToken({ sub: user.id, role, tv: user.tokenVersion }), cookieOptions);
    await audit({ req, actor: { id: user.id, email, role }, action: 'LOGIN', entityType: 'User', entityId: user.id });
    res.json({ user: await publicUser(user.id) });
  });
}

async function publicUser(userId: string) {
  const user = await User.findById(userId).lean();
  if (!user) return null;
  const employee = user.role === 'employee' ? await Employee.findOne({ user: userId }).lean() : null;
  return {
    id: String(user._id),
    email: user.email,
    name: user.name,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    employee: employee
      ? { id: String(employee._id), employeeId: employee.employeeId, department: employee.department, designation: employee.designation }
      : null,
  };
}

router.post('/login', validate({ body: loginBody }), loginHandler('employee'));
router.post('/admin/login', validate({ body: loginBody }), loginHandler('admin'));

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: undefined });
    res.json({ message: 'Logged out' });
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ user: await publicUser(req.user!.id) });
  }),
);

router.post(
  '/forgot-password',
  validate({ body: z.object({ email: z.string().email().toLowerCase().trim() }) }),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ email: req.body.email });
    if (user && user.isActive) {
      const token = randomToken();
      user.resetTokenHash = sha256(token);
      user.resetTokenExpires = new Date(Date.now() + 60 * 60_000);
      await user.save();
      const link = `${env.CLIENT_URL}/reset-password?token=${token}&portal=${user.role}`;
      await sendMail(user.email, 'Reset your password', `<p>Hi ${user.name},</p><p>Use the link below to reset your password (valid for 1 hour):</p><p><a href="${link}">${link}</a></p>`);
      await audit({ req, actor: { id: user.id, email: user.email, role: user.role }, action: 'PASSWORD_RESET_REQUESTED', entityType: 'User', entityId: user.id });
    }
    // same response whether or not the account exists
    res.json({ message: 'If that email is registered, a reset link has been sent.' });
  }),
);

router.post(
  '/reset-password',
  validate({ body: z.object({ token: z.string().min(20).max(200), password: strongPassword }) }),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({
      resetTokenHash: sha256(req.body.token),
      resetTokenExpires: { $gt: new Date() },
    }).select('+resetTokenHash +resetTokenExpires');
    if (!user) throw new ApiError(400, 'Reset link is invalid or has expired');
    user.passwordHash = await hashPassword(req.body.password);
    user.resetTokenHash = undefined;
    user.resetTokenExpires = undefined;
    user.mustChangePassword = false;
    user.failedLogins = 0;
    user.lockUntil = undefined;
    user.tokenVersion += 1;
    await user.save();
    await audit({ req, actor: { id: user.id, email: user.email, role: user.role }, action: 'PASSWORD_RESET', entityType: 'User', entityId: user.id });
    res.json({ message: 'Password updated. You can now log in.' });
  }),
);

router.post(
  '/change-password',
  authenticate,
  validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: strongPassword }) }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user!.id).select('+passwordHash');
    if (!user || !(await comparePassword(req.body.currentPassword, user.passwordHash))) throw new ApiError(400, 'Current password is incorrect');
    if (req.body.currentPassword === req.body.newPassword) throw new ApiError(400, 'New password must be different');
    user.passwordHash = await hashPassword(req.body.newPassword);
    user.mustChangePassword = false;
    user.tokenVersion += 1; // log out every other device
    await user.save();
    res.cookie(COOKIE_NAME, signToken({ sub: user.id, role: user.role as 'admin' | 'employee', tv: user.tokenVersion }), cookieOptions);
    await audit({ req, action: 'PASSWORD_CHANGED', entityType: 'User', entityId: user.id });
    res.json({ user: await publicUser(user.id) });
  }),
);

export default router;
