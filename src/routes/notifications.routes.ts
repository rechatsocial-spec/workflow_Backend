import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { Notification } from '../models/notification.model';
import { ApiError, asyncHandler, idParam, pageMeta, pageQuery, validate } from '../utils/http';

const router = Router();
router.use(authenticate);

router.get(
  '/',
  validate({ query: pageQuery.extend({ unread: z.enum(['true', 'false']).optional() }) }),
  asyncHandler(async (req, res) => {
    const { page, limit, unread } = req.query as any;
    const filter: Record<string, any> = { user: req.user!.id };
    if (unread === 'true') filter.read = false;
    const [total, unreadCount, items] = await Promise.all([
      Notification.countDocuments(filter),
      Notification.countDocuments({ user: req.user!.id, read: false }),
      Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    res.json({ items, unreadCount, ...pageMeta(total, page, limit) });
  }),
);

router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    await Notification.updateMany({ user: req.user!.id, read: false }, { read: true });
    res.json({ message: 'All marked as read' });
  }),
);

router.patch(
  '/:id/read',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const n = await Notification.findOneAndUpdate({ _id: req.params.id, user: req.user!.id }, { read: true }, { new: true });
    if (!n) throw new ApiError(404, 'Notification not found');
    res.json({ notification: n });
  }),
);

export default router;
