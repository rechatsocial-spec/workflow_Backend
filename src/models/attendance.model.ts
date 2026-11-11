import { Schema, model, InferSchemaType } from 'mongoose';

export const ATTENDANCE_STATUSES = ['in_progress', 'present', 'half_day', 'short'] as const;

const schema = new Schema(
  {
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    date: { type: String, required: true },
    session: { type: Schema.Types.ObjectId, ref: 'WorkSession' },
    status: { type: String, enum: ATTENDANCE_STATUSES, required: true },
    firstStart: Date,
    lastEnd: Date,
    workedMs: { type: Number, default: 0 },
    breakMs: { type: Number, default: 0 },
  },
  { timestamps: true },
);
// duplicate attendance records are impossible
schema.index({ employee: 1, date: 1 }, { unique: true });
schema.index({ date: 1 });

export type IAttendance = InferSchemaType<typeof schema>;
export const Attendance = model('Attendance', schema);
