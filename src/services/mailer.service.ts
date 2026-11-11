import nodemailer from 'nodemailer';
import { env } from '../config/env';

const transport = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null;

export async function sendMail(to: string, subject: string, html: string) {
  if (!transport) {
    // no SMTP configured: surface in the server log so dev/admin can still copy the link
    console.log(`[mail:console] to=${to} subject="${subject}"\n${html.replace(/<[^>]+>/g, ' ')}\n`);
    return false;
  }
  try {
    await transport.sendMail({ from: env.SMTP_FROM, to, subject, html });
    return true;
  } catch (e) {
    console.error('[mail] failed', e);
    return false;
  }
}
