import { Schema, model, InferSchemaType } from 'mongoose';

const schema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['admin', 'employee'], required: true },
    name: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
    mustChangePassword: { type: Boolean, default: false },
    /** bump to invalidate every issued JWT (password change, deactivation) */
    tokenVersion: { type: Number, default: 0 },
    resetTokenHash: { type: String, select: false },
    resetTokenExpires: { type: Date, select: false },
    lastLoginAt: Date,
    failedLogins: { type: Number, default: 0 },
    lockUntil: Date,
  },
  { timestamps: true },
);

export type IUser = InferSchemaType<typeof schema>;
export const User = model('User', schema);
