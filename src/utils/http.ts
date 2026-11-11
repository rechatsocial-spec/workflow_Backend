import { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const monthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

export const strongPassword = z
  .string()
  .min(8, 'Min 8 characters')
  .max(100)
  .regex(/[A-Za-z]/, 'Must include a letter')
  .regex(/\d/, 'Must include a number');

/** validate + replace req parts with parsed values (strips unknown keys) */
export const validate =
  (schemas: { body?: z.ZodType; query?: z.ZodType; params?: z.ZodType }): RequestHandler =>
  (req, _res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.params) req.params = schemas.params.parse(req.params) as any;
      if (schemas.query) (req as any).query = schemas.query.parse(req.query);
      next();
    } catch (e) {
      next(e);
    }
  };

export const idParam = z.object({ id: objectId });

export function pageMeta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

export function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
