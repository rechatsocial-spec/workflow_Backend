import { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env';
import { ApiError } from '../utils/http';

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof ApiError) {
    return res.status(err.status).json({ message: err.message, details: err.details });
  }
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? 'value';
    return res.status(409).json({ message: `Duplicate ${field}` });
  }
  if (err?.name === 'CastError') return res.status(400).json({ message: 'Invalid identifier' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ message: 'Malformed JSON' });

  console.error('[error]', err);
  res.status(500).json({ message: env.NODE_ENV === 'production' ? 'Internal server error' : String(err?.message ?? err) });
};
