import mongoose from 'mongoose';
import { env } from './env';

export async function connectDB(uri = env.MONGODB_URI) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  // make sure unique/partial indexes (overlap + duplicate protection) exist before serving traffic
  await mongoose.connection.syncIndexes();
  console.log('[db] connected');
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
