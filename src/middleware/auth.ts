import { RequestHandler } from 'express';
import { Employee } from '../models/employee.model';
import { User } from '../models/user.model';
import { ApiError, asyncHandler } from '../utils/http';
import { COOKIE_NAME, verifyToken } from '../utils/security';

export const authenticate: RequestHandler = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  const token = req.cookies?.[COOKIE_NAME] ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
  if (!token) throw new ApiError(401, 'Authentication required');

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw new ApiError(401, 'Session expired, please log in again');
  }

  const user = await User.findById(payload.sub);
  if (!user || user.tokenVersion !== payload.tv) throw new ApiError(401, 'Session expired, please log in again');
  if (!user.isActive) throw new ApiError(403, 'Account is deactivated');

  req.user = { id: user.id, role: user.role as 'admin' | 'employee', email: user.email, name: user.name };
  next();
});

export const requireRole =
  (role: 'admin' | 'employee'): RequestHandler =>
  (req, _res, next) => {
    if (req.user?.role !== role) return next(new ApiError(403, 'You do not have permission to do this'));
    next();
  };

export const requireAdmin = requireRole('admin');

/** employee-only endpoint: loads the caller's own Employee profile */
export const loadEmployee: RequestHandler = asyncHandler(async (req, _res, next) => {
  if (req.user?.role !== 'employee') throw new ApiError(403, 'Employee access only');
  const emp = await Employee.findOne({ user: req.user.id }).lean();
  if (!emp || !emp.isActive) throw new ApiError(403, 'Employee profile not found or inactive');
  req.employee = emp as any;
  next();
});
