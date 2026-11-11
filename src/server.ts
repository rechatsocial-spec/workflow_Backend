import http from 'http';
import mongoose from 'mongoose';
import { createApp } from './app';
import { connectDB } from './config/db';
import { env } from './config/env';
import { startScheduler } from './jobs/scheduler';
import { ensureAdmin } from './seed';
import { closeSocket, initSocket } from './socket';

export async function start(mongoUri?: string) {
  await connectDB(mongoUri);
  await ensureAdmin();
  const server = http.createServer(createApp());
  initSocket(server);
  const jobs = startScheduler();
  await new Promise<void>((r) => server.listen(env.PORT, r));
  console.log(`[server] http://localhost:${env.PORT} (${env.NODE_ENV}, tz=${env.APP_TIMEZONE})`);

  const shutdown = async (sig: string) => {
    console.log(`[server] ${sig} received, shutting down`);
    jobs.forEach((j) => j.stop());
    closeSocket();
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  return server;
}

if (require.main === module) {
  start().catch((e) => {
    console.error('[server] failed to start', e);
    process.exit(1);
  });
}
