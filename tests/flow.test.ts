process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
process.env.DISABLE_SCHEDULER = 'true';
process.env.ADMIN_EMAIL = 'admin@test.com';
process.env.ADMIN_PASSWORD = 'AdminPass123';

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let mongo: MongoMemoryServer;
let app: any;
const admin = () => request.agent(app);
const emp = () => request.agent(app);
let A: ReturnType<typeof admin>;
let E: ReturnType<typeof emp>;
let employeeDbId: string;
let taskId: string;
let tempPassword: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const { connectDB } = await import('../src/config/db');
  const { ensureAdmin } = await import('../src/seed');
  const { createApp } = await import('../src/app');
  await connectDB(mongo.getUri());
  await ensureAdmin();
  app = createApp();
  A = admin();
  E = emp();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('auth & RBAC', () => {
  it('rejects bad credentials and wrong portal', async () => {
    await request(app).post('/api/auth/admin/login').send({ email: 'admin@test.com', password: 'nope-nope1' }).expect(401);
    await request(app).post('/api/auth/login').send({ email: 'admin@test.com', password: 'AdminPass123' }).expect(401);
  });
  it('admin logs in', async () => {
    await A.post('/api/auth/admin/login').send({ email: 'admin@test.com', password: 'AdminPass123' }).expect(200);
    const me = await A.get('/api/auth/me').expect(200);
    expect(me.body.user.role).toBe('admin');
  });
  it('anonymous cannot reach admin API', async () => {
    await request(app).get('/api/employees').expect(401);
  });
});

describe('employee + task management', () => {
  it('admin creates employee with generated credentials', async () => {
    const r = await A.post('/api/employees')
      .send({ name: 'Jane Doe', email: 'jane@test.com', designation: 'Dev', department: 'Engineering', joiningDate: '2024-01-01' })
      .expect(201);
    employeeDbId = r.body.employee.id;
    tempPassword = r.body.credentials.password;
    expect(tempPassword.length).toBeGreaterThanOrEqual(12);
    expect(r.body.employee.employeeId).toMatch(/^EMP-\d{4}$/);
  });
  it('duplicate email rejected', async () => {
    await A.post('/api/employees')
      .send({ name: 'Jane 2', email: 'jane@test.com', designation: 'Dev', department: 'Engineering', joiningDate: '2024-01-01' })
      .expect(409);
  });
  it('employee logs in, is forced to change password, and cannot use admin APIs', async () => {
    const r = await E.post('/api/auth/login').send({ email: 'jane@test.com', password: tempPassword }).expect(200);
    expect(r.body.user.mustChangePassword).toBe(true);
    await E.get('/api/employees').expect(403);
    await E.post('/api/tasks').send({}).expect(403);
    await E.post('/api/auth/change-password').send({ currentPassword: tempPassword, newPassword: 'NewPass1234' }).expect(200);
  });
  it('admin assigns task; employee sees only own task and cannot edit it', async () => {
    const t = await A.post('/api/tasks')
      .send({ title: 'Build report page', description: 'x', assignedTo: employeeDbId, deadline: new Date(Date.now() + 86400000).toISOString(), priority: 'high' })
      .expect(201);
    taskId = t.body.task._id;
    const list = await E.get('/api/tasks').expect(200);
    expect(list.body.items).toHaveLength(1);
    await E.patch(`/api/tasks/${taskId}`).send({ status: 'completed' }).expect(403);
    await E.delete(`/api/tasks/${taskId}`).expect(403);
    const n = await E.get('/api/notifications').expect(200);
    expect(n.body.items.some((x: any) => x.type === 'task_assigned')).toBe(true);
  });
});

describe('work session lifecycle', () => {
  it('cannot submit an update or break before starting', async () => {
    await E.post('/api/updates').send({ completedWork: 'did stuff', progress: 10, pendingWork: 'more' }).expect(409);
    await E.post('/api/sessions/break/start').expect(409);
  });
  it('starts once; duplicate start is blocked', async () => {
    const s = await E.post('/api/sessions/start').expect(201);
    expect(s.body.status).toBe('active');
    await E.post('/api/sessions/start').expect(409);
  });
  it('concurrent starts create only one session', async () => {
    // fresh employee to isolate
    const c = await A.post('/api/employees').send({ name: 'Race Cond', email: 'race@test.com', designation: 'QA', department: 'QA', joiningDate: '2024-01-01' }).expect(201);
    const R = emp();
    await R.post('/api/auth/login').send({ email: 'race@test.com', password: c.body.credentials.password }).expect(200);
    const rs = await Promise.all([R.post('/api/sessions/start'), R.post('/api/sessions/start'), R.post('/api/sessions/start')]);
    expect(rs.filter((x) => x.status === 201)).toHaveLength(1);
    expect(rs.filter((x) => x.status === 409)).toHaveLength(2);
  });
  it('break → resume tracked; double break blocked', async () => {
    await E.post('/api/sessions/break/start').expect(200);
    await E.post('/api/sessions/break/start').expect(409);
    const s = await E.get('/api/sessions/today').expect(200);
    expect(s.body.status).toBe('on_break');
    await new Promise((r) => setTimeout(r, 1100));
    const resumed = await E.post('/api/sessions/break/end').expect(200);
    expect(resumed.body.status).toBe('active');
    expect(resumed.body.breakMs).toBeGreaterThanOrEqual(1000);
    await E.post('/api/sessions/break/end').expect(409);
  });
  it('update drives task progress; 100% completes task and notifies admin', async () => {
    await E.post('/api/updates').send({ taskId, completedWork: 'Built the layout', progress: 50, pendingWork: 'API wiring' }).expect(201);
    let t = await E.get(`/api/tasks/${taskId}`).expect(200);
    expect(t.body.task.status).toBe('in_progress');
    await E.post('/api/updates').send({ taskId, completedWork: 'All done now', progress: 100, pendingWork: 'none' }).expect(201);
    t = await E.get(`/api/tasks/${taskId}`).expect(200);
    expect(t.body.task.status).toBe('completed');
    const n = await A.get('/api/notifications').expect(200);
    expect(n.body.items.some((x: any) => x.type === 'task_completed')).toBe(true);
    const ups = await A.get('/api/updates').expect(200);
    expect(ups.body.total).toBe(2);
  });
  it('employee cannot report on someone else’s task', async () => {
    const other = await A.post('/api/employees').send({ name: 'Other Guy', email: 'other@test.com', designation: 'Staff', department: 'Ops', joiningDate: '2024-01-01' }).expect(201);
    const t = await A.post('/api/tasks').send({ title: 'Other task', assignedTo: other.body.employee.id, deadline: new Date(Date.now() + 86400000).toISOString() }).expect(201);
    await E.post('/api/updates').send({ taskId: t.body.task._id, completedWork: 'sneaky work', progress: 10, pendingWork: 'more work' }).expect(404);
  });
  it('end excludes break time; second end is blocked', async () => {
    const end = await E.post('/api/sessions/end').expect(200);
    expect(end.body.status).toBe('completed');
    expect(end.body.session.breakMs).toBeGreaterThanOrEqual(1000);
    expect(end.body.session.workedMs + end.body.session.breakMs).toBeLessThanOrEqual(end.body.session.elapsedMs + 5);
    await E.post('/api/sessions/end').expect(409);
    await E.post('/api/sessions/start').expect(409); // one session per day
  });
});

describe('monitoring, analytics, reports', () => {
  it('admin sees logs, live board, analytics', async () => {
    const s = await A.get('/api/monitoring/sessions').expect(200);
    expect(s.body.total).toBeGreaterThanOrEqual(1);
    await A.get('/api/monitoring/live').expect(200);
    await A.get('/api/monitoring/missing-updates').expect(200);
    const a = await A.get('/api/analytics/overview?range=month').expect(200);
    expect(a.body.cards.tasksCompleted).toBe(1);
    expect(a.body.cards.totalEmployees).toBe(3);
  });
  it('employee cannot read monitoring/analytics/audit', async () => {
    await E.get('/api/monitoring/sessions').expect(403);
    await E.get('/api/analytics/overview').expect(403);
    await E.get('/api/audit').expect(403);
  });
  it('employee downloads own PDF + XLSX; admin downloads any + consolidated', async () => {
    const pdf = await E.get('/api/reports/monthly?format=pdf').buffer().parse((res, cb) => {
      const c: Buffer[] = [];
      res.on('data', (d: Buffer) => c.push(d));
      res.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    const xlsx = await E.get('/api/reports/monthly?format=xlsx').buffer().parse((res, cb) => {
      const c: Buffer[] = [];
      res.on('data', (d: Buffer) => c.push(d));
      res.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');

    await A.get(`/api/reports/monthly?format=pdf&employeeId=${employeeDbId}`).expect(200);
    await A.get('/api/reports/monthly?format=pdf').expect(400);
    await A.get('/api/reports/consolidated?format=xlsx').expect(200);
    await A.get('/api/reports/consolidated?format=pdf').expect(200);
    await E.get('/api/reports/consolidated').expect(403);
  });
  it('audit log recorded important actions', async () => {
    const r = await A.get('/api/audit?limit=100').expect(200);
    const actions = r.body.items.map((i: any) => i.action);
    for (const a of ['LOGIN', 'EMPLOYEE_CREATED', 'TASK_CREATED', 'WORK_STARTED', 'BREAK_STARTED', 'BREAK_ENDED', 'UPDATE_SUBMITTED', 'WORK_ENDED', 'REPORT_DOWNLOADED']) {
      expect(actions).toContain(a);
    }
  });
});

describe('admin-chosen simple password', () => {
  it('admin sets a simple password on create and on reset', async () => {
    const c = await A.post('/api/employees').send({ name: 'Simple Sam', email: 'sam@test.com', designation: 'Ops', department: 'Ops', joiningDate: '2024-01-01', password: '1234', mustChangePassword: false }).expect(201);
    expect(c.body.credentials.password).toBe('1234');
    const S = emp();
    const l = await S.post('/api/auth/login').send({ email: 'sam@test.com', password: '1234' }).expect(200);
    expect(l.body.user.mustChangePassword).toBe(false);
    await A.post(`/api/employees/${c.body.employee.id}/reset-credentials`).send({ password: 'abcd', mustChangePassword: true }).expect(200);
    const l2 = await request(app).post('/api/auth/login').send({ email: 'sam@test.com', password: 'abcd' }).expect(200);
    expect(l2.body.user.mustChangePassword).toBe(true);
    await A.post(`/api/employees/${c.body.employee.id}/reset-credentials`).send({ password: 'ab' }).expect(400);
  });
});

describe('deactivation', () => {
  it('deactivated employee is locked out immediately', async () => {
    await A.patch(`/api/employees/${employeeDbId}/status`).send({ isActive: false }).expect(200);
    await E.get('/api/sessions/today').expect(401);
    await request(app).post('/api/auth/login').send({ email: 'jane@test.com', password: 'NewPass1234' }).expect(403);
  });
});
