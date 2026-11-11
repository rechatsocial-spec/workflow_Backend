import { Schema, model, InferSchemaType } from 'mongoose';

export const NOTIFICATION_TYPES = [
  'task_assigned',
  'task_updated',
  'deadline_approaching',
  'update_reminder',
  'break_reminder',
  'work_started',
  'work_ended',
  'missing_update',
  'task_completed',
  'attendance_summary',
  'system',
] as const;

const schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    link: String,
    data: Schema.Types.Mixed,
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);
schema.index({ user: 1, read: 1, createdAt: -1 });

export type INotification = InferSchemaType<typeof schema>;
export const Notification = model('Notification', schema);
