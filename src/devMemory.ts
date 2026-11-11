/** Dev convenience: runs the API against a throw-away in-memory MongoDB (no install needed). Data is lost on exit. */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { start } from './server';

MongoMemoryServer.create().then((m) => {
  console.log('[dev:mem] in-memory MongoDB at', m.getUri());
  return start(m.getUri());
});
