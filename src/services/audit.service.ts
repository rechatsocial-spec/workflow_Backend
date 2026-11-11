import { Request } from 'express';
import { AuditLog } from '../models/auditLog.model';

interface AuditInput {
  req?: Request;
  actor?: { id?: string; email?: string; role?: string };
  action: string;
  entityType?: string;
  entityId?: unknown;
  metadata?: Record<string, unknown>;
}

/** Fire-and-forget: audit failures must never break the request. */
export async function audit({ req, actor, action, entityType, entityId, metadata }: AuditInput) {
  try {
    const a = actor ?? req?.user;
    await AuditLog.create({
      actor: a?.id,
      actorEmail: a?.email,
      actorRole: a?.role,
      action,
      entityType,
      entityId: entityId ? String(entityId) : undefined,
      metadata,
      ip: req?.ip,
    });
  } catch (e) {
    console.error('[audit] failed', e);
  }
}
