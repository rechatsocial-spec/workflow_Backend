import { connectDB, disconnectDB } from './config/db';
import { env } from './config/env';
import { User } from './models/user.model';
import { hashPassword } from './utils/security';

/** creates the first admin when none exists */
export async function ensureAdmin() {
  if (await User.exists({ role: 'admin' })) return;
  await User.create({
    email: env.ADMIN_EMAIL.toLowerCase(),
    name: env.ADMIN_NAME,
    role: 'admin',
    passwordHash: await hashPassword(env.ADMIN_PASSWORD),
    mustChangePassword: env.NODE_ENV === 'production',
  });
  console.log(`[seed] admin created: ${env.ADMIN_EMAIL}`);
}

if (require.main === module) {
  connectDB()
    .then(ensureAdmin)
    .then(disconnectDB);
}
