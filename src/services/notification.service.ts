import { INotification, Notification } from '../models/notification.model';
import { User } from '../models/user.model';
import { emitToAdmins, emitToUser } from '../socket';

type NotifyInput = Pick<INotification, 'type' | 'title' | 'message'> & { link?: string; data?: unknown };

export async function notifyUser(userId: unknown, input: NotifyInput) {
  try {
    const n = await Notification.create({ ...input, user: userId as any });
    emitToUser(String(userId), 'notification', n.toJSON());
    return n;
  } catch (e) {
    console.error('[notify] failed', e);
  }
}

export async function notifyAdmins(input: NotifyInput) {
  try {
    const admins = await User.find({ role: 'admin', isActive: true }).select('_id').lean();
    if (!admins.length) return;
    const docs = await Notification.insertMany(admins.map((a) => ({ ...input, user: a._id })));
    docs.forEach((d) => emitToUser(String(d.user), 'notification', d));
  } catch (e) {
    console.error('[notify] admins failed', e);
  }
}

/** tell connected admin dashboards to refetch live data */
export const pingMonitor = () => emitToAdmins('monitor:refresh', { at: Date.now() });
