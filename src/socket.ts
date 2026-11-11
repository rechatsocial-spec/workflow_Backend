import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { env } from './config/env';
import { User } from './models/user.model';
import { COOKIE_NAME, verifyToken } from './utils/security';

let io: Server | null = null;

function parse(header: string): Record<string, string> {
  return Object.fromEntries(
    header.split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );
}

export function initSocket(server: HttpServer) {
  io = new Server(server, { cors: { origin: env.CLIENT_URL, credentials: true } });

  io.use(async (socket, next) => {
    try {
      const token = parse(socket.handshake.headers.cookie ?? '')[COOKIE_NAME];
      if (!token) return next(new Error('unauthorized'));
      const p = verifyToken(token);
      const user = await User.findById(p.sub);
      if (!user || !user.isActive || user.tokenVersion !== p.tv) return next(new Error('unauthorized'));
      socket.data.userId = user.id;
      socket.data.role = user.role;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`);
    if (socket.data.role === 'admin') socket.join('admins');
  });
  return io;
}

export const emitToUser = (userId: string, event: string, payload: unknown) =>
  io?.to(`user:${userId}`).emit(event, payload);
export const emitToAdmins = (event: string, payload: unknown) => io?.to('admins').emit(event, payload);
export const closeSocket = () => io?.close();
