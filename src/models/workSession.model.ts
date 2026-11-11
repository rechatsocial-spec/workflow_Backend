import { Schema, model, InferSchemaType } from 'mongoose';

const schema = new Schema(
  {
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    /** YYYY-MM-DD in company timezone */
    date: { type: String, required: true },
    startTime: { type: Date, required: true },
    endTime: Date,
    status: { type: String, enum: ['active', 'on_break', 'completed'], default: 'active' },
    /** true while session is running (active or on break). Drives the "no overlapping sessions" index */
    isOpen: { type: Boolean, default: true },
    lastHeartbeat: Date,
    workedMs: { type: Number, default: 0 },
    breakMs: { type: Number, default: 0 },
    autoClosed: { type: Boolean, default: false },
    nextUpdateDue: Date,
    reminderSent: { type: Boolean, default: false },
    missedNotified: { type: Boolean, default: false },
    segmentStart: Date,
    breakReminderSent: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// one session per employee per day => no duplicate attendance
schema.index({ employee: 1, date: 1 }, { unique: true });
// at most one open session per employee => no overlapping sessions
schema.index({ employee: 1 }, { unique: true, partialFilterExpression: { isOpen: true }, name: 'one_open_session_per_employee' });
schema.index({ date: 1 });
schema.index({ isOpen: 1, nextUpdateDue: 1 });

export type IWorkSession = InferSchemaType<typeof schema>;
export const WorkSession = model('WorkSession', schema);
