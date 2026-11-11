import { Schema, model, InferSchemaType } from 'mongoose';

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const;

const schema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 5000, default: '' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    assignedDate: { type: Date, default: Date.now },
    deadline: { type: Date, required: true },
    priority: { type: String, enum: PRIORITIES, default: 'medium' },
    status: { type: String, enum: TASK_STATUSES, default: 'pending', index: true },
    progress: { type: Number, min: 0, max: 100, default: 0 },
    completedAt: Date,
    deadlineNotified: { type: Boolean, default: false },
  },
  { timestamps: true },
);
schema.index({ assignedTo: 1, status: 1 });
schema.index({ status: 1, deadline: 1 });

export type ITask = InferSchemaType<typeof schema>;
export const Task = model('Task', schema);
