import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { env } from './config/env';
import { errorHandler, notFound } from './middleware/error';
import analytics from './routes/analytics.routes';
import audit from './routes/audit.routes';
import auth from './routes/auth.routes';
import employees from './routes/employees.routes';
import monitoring from './routes/monitoring.routes';
import notifications from './routes/notifications.routes';
import reports from './routes/reports.routes';
import sessions from './routes/sessions.routes';
import tasks from './routes/tasks.routes';
import updates from './routes/updates.routes';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: env.CLIENT_URL, credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  if (env.NODE_ENV !== 'test') app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  const skip = () => env.NODE_ENV === 'test';
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false, skip }));
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, skip, message: { message: 'Too many attempts, try again later' } });
  app.use(['/api/auth/login', '/api/auth/admin/login', '/api/auth/forgot-password', '/api/auth/reset-password'], authLimiter);

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.use('/api/auth', auth);
  app.use('/api/employees', employees);
  app.use('/api/tasks', tasks);
  app.use('/api/sessions', sessions);
  app.use('/api/updates', updates);
  app.use('/api/monitoring', monitoring);
  app.use('/api/analytics', analytics);
  app.use('/api/notifications', notifications);
  app.use('/api/reports', reports);
  app.use('/api/audit', audit);
  app.use('/api', notFound);

  // production: serve the built React app from the same origin (cookie auth stays first-party)
  const dist = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
