import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const DEFAULT_SECRET = 'dev-only-secret-change-me-in-production';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(5000),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/work_management'),
  JWT_SECRET: z.string().min(16).default(DEFAULT_SECRET),
  JWT_EXPIRES_IN_HOURS: z.coerce.number().default(12),
  CLIENT_URL: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: bool,
  APP_TIMEZONE: z.string().default('UTC'),
  DAILY_TARGET_HOURS: z.coerce.number().default(8),
  UPDATE_INTERVAL_MINUTES: z.coerce.number().default(120),
  UPDATE_GRACE_MINUTES: z.coerce.number().default(15),
  BREAK_REMINDER_MINUTES: z.coerce.number().default(0),
  DEADLINE_WARNING_HOURS: z.coerce.number().default(24),
  ADMIN_NAME: z.string().default('Administrator'),
  ADMIN_EMAIL: z.string().default('admin@company.com'),
  ADMIN_PASSWORD: z.string().default('ChangeMe@12345'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('Work Management <no-reply@localhost>'),
  DISABLE_SCHEDULER: bool,
});

export const env = schema.parse(process.env);

if (env.NODE_ENV === 'production' && env.JWT_SECRET === DEFAULT_SECRET) {
  throw new Error('JWT_SECRET must be set to a strong random value in production');
}

export const TARGET_MS = env.DAILY_TARGET_HOURS * 3_600_000;
export const UPDATE_INTERVAL_MS = env.UPDATE_INTERVAL_MINUTES * 60_000;
export const UPDATE_GRACE_MS = env.UPDATE_GRACE_MINUTES * 60_000;
