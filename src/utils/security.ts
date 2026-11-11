import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export const hashPassword = (pw: string) => bcrypt.hash(pw, 12);
export const comparePassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

/** cryptographically random password that always satisfies the password policy */
export function generatePassword(length = 12) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '@#$%&*!';
  const all = upper + lower + digits + symbols;
  const pick = (set: string) => set[crypto.randomInt(set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('hex');

export interface JwtPayload {
  sub: string;
  role: 'admin' | 'employee';
  tv: number;
}

export const signToken = (p: JwtPayload) =>
  jwt.sign(p, env.JWT_SECRET, { expiresIn: `${env.JWT_EXPIRES_IN_HOURS}h` });

export const verifyToken = (t: string) => jwt.verify(t, env.JWT_SECRET) as JwtPayload & { exp: number };

export const COOKIE_NAME = 'wm_token';
export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.COOKIE_SECURE,
  maxAge: env.JWT_EXPIRES_IN_HOURS * 3_600_000,
  path: '/',
};
