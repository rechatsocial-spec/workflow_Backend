import { Schema, model, InferSchemaType } from 'mongoose';

const schema = new Schema(
  {
    session: { type: Schema.Types.ObjectId, ref: 'WorkSession', required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    task: { type: Schema.Types.ObjectId, ref: 'Task' },
    date: { type: String, required: true },
    completedWork: { type: String, required: true, trim: true, maxlength: 5000 },
    progress: { type: Number, required: true, min: 0, max: 100 },
    pendingWork: { type: String, required: true, trim: true, maxlength: 5000 },
    challenges: { type: String, trim: true, maxlength: 5000, default: '' },
    submittedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
schema.index({ employee: 1, submittedAt: -1 });
schema.index({ date: 1 });

export type IWorkUpdate = InferSchemaType<typeof schema>;
export const WorkUpdate = model('WorkUpdate', schema);
