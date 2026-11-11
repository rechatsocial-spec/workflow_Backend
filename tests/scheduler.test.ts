process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
process.env.DISABLE_SCHEDULER = 'true';
process.env.ADMIN_EMAIL = 'admin@test.com';

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let mongo: MongoMemoryServer;
let empId: any;
let userId: any;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const { connectDB } = await import('../src/config/db');
  await connectDB(mongo.getUri());
  const { ensureAdmin } = await import('../src/seed');
  await ensureAdmin();
  const { User } = await import('../src/models/user.model');
  const { Employee } = await import('../src/models/employee.model');
  const u = await User.create({ email: 'e@test.com', name: 'Eve', role: 'employee', passwordHash: 'x' });
  const e = await Employee.create({ user: u._id, employeeId: 'EMP-0001', name: 'Eve', designation: 'Dev', department: 'Eng', joiningDate: new Date('2024-01-01') });
  empId = e._id;
  userId = u._id;
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('scheduler', () => {
  it('reminds employee when update is due, then escalates to admin after grace — exactly once', async () => {
    const { WorkSession } = await import('../src/models/workSession.model');
    const { Notification } = await import('../src/models/notification.model');
    const { _test } = await import('../src/jobs/scheduler');
    const { dateKey } = await import('../src/utils/time');

    const start = new Date(Date.now() - 3 * 3600_000);
    await WorkSession.create({ employee: empId, date: dateKey(), startTime: start, lastHeartbeat: new Date(), nextUpdateDue: new Date(Date.now() - 30 * 60_000) });

    await _test.updateReminders();
    await _test.updateReminders(); // second run must not duplicate

    expect(await Notification.countDocuments({ user: userId, type: 'update_reminder' })).toBe(1);
    expect(await Notification.countDocuments({ type: 'missing_update' })).toBe(1); // 30 min > 15 min grace
  });

  it('auto-closes a session left open from a previous day at its last heartbeat', async () => {
    const { WorkSession } = await import('../src/models/workSession.model');
    const { Attendance } = await import('../src/models/attendance.model');
    const { _test } = await import('../src/jobs/scheduler');
    await WorkSession.deleteMany({});
    const start = new Date(Date.now() - 30 * 3600_000);
    const beat = new Date(start.getTime() + 5 * 3600_000);
    const s = await WorkSession.create({ employee: empId, date: '2020-01-01', startTime: start, lastHeartbeat: beat });
    await _test.closeStaleSessions();
    const closed = await WorkSession.findById(s._id).lean();
    expect(closed?.isOpen).toBe(false);
    expect(closed?.autoClosed).toBe(true);
    expect(closed?.workedMs).toBe(5 * 3600_000);
    expect(await Attendance.findOne({ employee: empId, date: '2020-01-01' })).toBeTruthy();
  });

  it('sends deadline reminders once', async () => {
    const { Task } = await import('../src/models/task.model');
    const { Notification } = await import('../src/models/notification.model');
    const { User } = await import('../src/models/user.model');
    const { _test } = await import('../src/jobs/scheduler');
    const admin = await User.findOne({ role: 'admin' });
    await Task.create({ title: 'Soon', assignedTo: empId, assignedBy: admin!._id, deadline: new Date(Date.now() + 3 * 3600_000) });
    await _test.deadlineReminders();
    await _test.deadlineReminders();
    expect(await Notification.countDocuments({ user: userId, type: 'deadline_approaching' })).toBe(1);
  });
});
