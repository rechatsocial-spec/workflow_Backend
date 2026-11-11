import { Schema, model, InferSchemaType } from 'mongoose';

const schema = new Schema(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    actorEmail: String,
    actorRole: String,
    action: { type: String, required: true, index: true },
    entityType: String,
    entityId: String,
    metadata: Schema.Types.Mixed,
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
schema.index({ createdAt: -1 });
schema.index({ actor: 1, createdAt: -1 });

export type IAuditLog = InferSchemaType<typeof schema>;
export const AuditLog = model('AuditLog', schema);
