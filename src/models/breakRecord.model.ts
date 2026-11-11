import { Schema, model, InferSchemaType } from 'mongoose';

const schema = new Schema(
  {
    session: { type: Schema.Types.ObjectId, ref: 'WorkSession', required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    date: { type: String, required: true },
    startTime: { type: Date, required: true },
    endTime: Date,
    durationMs: { type: Number, default: 0 },
    /** true while the break is running */
    open: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// one running break per session
schema.index({ session: 1 }, { unique: true, partialFilterExpression: { open: true }, name: 'one_open_break_per_session' });

export type IBreakRecord = InferSchemaType<typeof schema>;
export const BreakRecord = model('BreakRecord', schema);
