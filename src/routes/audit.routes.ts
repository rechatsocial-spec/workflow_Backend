import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAdmin } from '../middleware/auth';
import { AuditLog } from '../models/auditLog.model';
import { asyncHandler, dateStr, escapeRegex, pageMeta, pageQuery, validate } from '../utils/http';

const router = Router();
router.use(authenticate, requireAdmin);

router.get(
  '/',
  validate({ query: pageQuery.extend({ q: z.string().trim().optional(), action: z.string().trim().optional(), from: dateStr.optional(), to: dateStr.optional() }) }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, action, from, to } = req.query as any;
    const filter: Record<string, any> = {};
    if (action) filter.action = action;
    if (q) filter.$or = [{ actorEmail: new RegExp(escapeRegex(q), 'i') }, { action: new RegExp(escapeRegex(q), 'i') }];
    if (from || to) filter.createdAt = { ...(from && { $gte: new Date(`${from}T00:00:00.000Z`) }), ...(to && { $lte: new Date(`${to}T23:59:59.999Z`) }) };
    const [total, items] = await Promise.all([
      AuditLog.countDocuments(filter),
      AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    res.json({ items, ...pageMeta(total, page, limit) });
  }),
);

export default router;
