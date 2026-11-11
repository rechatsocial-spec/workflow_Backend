import { Schema, model, InferSchemaType } from 'mongoose';

const counter = model('Counter', new Schema({ _id: String, seq: { type: Number, default: 0 } }));

export async function nextEmployeeId(): Promise<string> {
  const c = await counter.findOneAndUpdate({ _id: 'employee' }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `EMP-${String(c!.seq).padStart(4, '0')}`;
}

const schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    employeeId: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    designation: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true, index: true },
    joiningDate: { type: Date, required: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

export type IEmployee = InferSchemaType<typeof schema>;
export const Employee = model('Employee', schema);
