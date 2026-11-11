import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { TARGET_MS } from '../config/env';
import { Employee } from '../models/employee.model';
import { Task } from '../models/task.model';
import { WorkSession } from '../models/workSession.model';
import { attendanceStatus, decorateSessions } from './session.service';
import { dateKey, fmtDuration, hoursOf, isWeekend, monthDays, monthLabel, timeLabel, weekdayShort } from '../utils/time';

export interface DayRow {
  date: string;
  weekday: string;
  start: string;
  end: string;
  workedMs: number;
  breakMs: number;
  updates: number;
  status: string;
}
export interface MonthlyReport {
  employee: { name: string; employeeId: string; department: string; designation: string; email?: string };
  month: string;
  label: string;
  rows: DayRow[];
  tasks: { title: string; priority: string; status: string; deadline: Date }[];
  summary: {
    workingDays: number;
    daysPresent: number;
    halfDays: number;
    daysAbsent: number;
    totalWorkedMs: number;
    totalBreakMs: number;
    updates: number;
    tasksAssigned: number;
    tasksCompleted: number;
    tasksPending: number;
  };
}

const STATUS_LABEL: Record<string, string> = {
  present: 'Present',
  half_day: 'Half day',
  short: 'Short hours',
  in_progress: 'Working',
  absent: 'Absent',
  weekend: 'Weekend',
  upcoming: '',
  not_joined: '-',
};

/** Batch loader – one set of queries for N employees (used by single + consolidated reports) */
export async function buildMonthlyReports(employeeIds: unknown[], month: string): Promise<MonthlyReport[]> {
  const days = monthDays(month);
  const first = days[0];
  const last = days[days.length - 1];
  const today = dateKey();
  const monthStart = new Date(`${first}T00:00:00.000Z`);
  const monthEnd = new Date(`${last}T23:59:59.999Z`);

  const employees = await Employee.find({ _id: { $in: employeeIds } }).populate<{ user: { email: string } }>('user', 'email').sort({ employeeId: 1 }).lean();
  const ids = employees.map((e) => e._id);

  const [sessionsRaw, tasks] = await Promise.all([
    WorkSession.find({ employee: { $in: ids }, date: { $gte: first, $lte: last } }).lean(),
    Task.find({
      assignedTo: { $in: ids },
      $or: [
        { assignedDate: { $gte: monthStart, $lte: monthEnd } },
        { completedAt: { $gte: monthStart, $lte: monthEnd } },
        { assignedDate: { $lte: monthEnd }, status: { $ne: 'completed' } },
      ],
    }).lean(),
  ]);
  const sessions = await decorateSessions(sessionsRaw);

  return employees.map((emp) => {
    const mySessions = new Map(sessions.filter((s) => String(s.employee) === String(emp._id)).map((s) => [s.date, s]));
    const joined = dateKey(emp.joiningDate);
    const rows: DayRow[] = days.map((date) => {
      const s = mySessions.get(date);
      let status: string;
      if (s) status = attendanceStatus(s.workedMs, s.isOpen as boolean);
      else if (date > today) status = 'upcoming';
      else if (date < joined) status = 'not_joined';
      else if (isWeekend(date)) status = 'weekend';
      else status = 'absent';
      return {
        date,
        weekday: weekdayShort(date),
        start: timeLabel(s?.startTime),
        end: s?.endTime ? timeLabel(s.endTime) : s ? 'In progress' : '',
        workedMs: s?.workedMs ?? 0,
        breakMs: s?.breakMs ?? 0,
        updates: s?.updatesCount ?? 0,
        status,
      };
    });

    const myTasks = tasks.filter((t) => String(t.assignedTo) === String(emp._id));
    const inMonth = (d?: Date | null) => !!d && d >= monthStart && d <= monthEnd;
    const assigned = myTasks.filter((t) => inMonth(t.assignedDate));
    const completed = myTasks.filter((t) => inMonth(t.completedAt));
    const pending = myTasks.filter((t) => t.status !== 'completed' || (t.completedAt && t.completedAt > monthEnd));

    const count = (st: string) => rows.filter((r) => r.status === st).length;
    const workingDays = rows.filter((r) => !['upcoming', 'weekend', 'not_joined'].includes(r.status) || (mySessions.has(r.date) && r.status !== 'upcoming')).length;
    const reportTasks = [...new Map([...assigned, ...completed, ...pending].map((t) => [String(t._id), t])).values()];

    return {
      employee: { name: emp.name, employeeId: emp.employeeId, department: emp.department, designation: emp.designation, email: emp.user?.email },
      month,
      label: monthLabel(month),
      rows,
      tasks: reportTasks.map((t) => ({ title: t.title, priority: t.priority, status: t.status, deadline: t.deadline })),
      summary: {
        workingDays,
        daysPresent: count('present') + count('in_progress'),
        halfDays: count('half_day'),
        daysAbsent: count('absent'),
        totalWorkedMs: rows.reduce((s, r) => s + r.workedMs, 0),
        totalBreakMs: rows.reduce((s, r) => s + r.breakMs, 0),
        updates: rows.reduce((s, r) => s + r.updates, 0),
        tasksAssigned: assigned.length,
        tasksCompleted: completed.length,
        tasksPending: pending.length,
      },
    };
  });
}

/* ───────────────────────────── Excel ───────────────────────────── */

const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEAD_FILL;
  row.alignment = { vertical: 'middle', horizontal: 'center' };
}

const DAY_COLS = [
  { header: 'Date', key: 'date', width: 13 },
  { header: 'Day', key: 'weekday', width: 7 },
  { header: 'Start', key: 'start', width: 10 },
  { header: 'End', key: 'end', width: 12 },
  { header: 'Working hrs', key: 'worked', width: 13 },
  { header: 'Break hrs', key: 'brk', width: 11 },
  { header: 'Updates', key: 'updates', width: 10 },
  { header: 'Status', key: 'status', width: 14 },
];

export async function monthlyExcel(r: MonthlyReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Work Management System';
  const ws = wb.addWorksheet('Timesheet');
  ws.mergeCells('A1:H1');
  ws.getCell('A1').value = `Monthly Work Report — ${r.label}`;
  ws.getCell('A1').font = { size: 16, bold: true };
  const info: [string, string | number][] = [
    ['Employee', r.employee.name],
    ['Employee ID', r.employee.employeeId],
    ['Department', r.employee.department],
    ['Designation', r.employee.designation],
    ['Month', r.label],
    ['Monthly working hours', hoursOf(r.summary.totalWorkedMs)],
    ['Monthly break hours', hoursOf(r.summary.totalBreakMs)],
    ['Days present / half / absent', `${r.summary.daysPresent} / ${r.summary.halfDays} / ${r.summary.daysAbsent}`],
    ['Updates submitted', r.summary.updates],
    ['Tasks assigned / completed / pending', `${r.summary.tasksAssigned} / ${r.summary.tasksCompleted} / ${r.summary.tasksPending}`],
  ];
  info.forEach(([k, v], i) => {
    ws.getCell(`A${3 + i}`).value = k;
    ws.getCell(`A${3 + i}`).font = { bold: true };
    ws.mergeCells(`A${3 + i}:C${3 + i}`);
    ws.getCell(`D${3 + i}`).value = v;
  });
  const headRow = 3 + info.length + 1;
  ws.getRow(headRow).values = DAY_COLS.map((c) => c.header);
  styleHeader(ws.getRow(headRow));
  DAY_COLS.forEach((c, i) => (ws.getColumn(i + 1).width = c.width));
  r.rows.forEach((d, i) => {
    const row = ws.getRow(headRow + 1 + i);
    row.values = [d.date, d.weekday, d.start, d.end, hoursOf(d.workedMs), hoursOf(d.breakMs), d.updates, STATUS_LABEL[d.status] ?? d.status];
    if (d.status === 'absent') row.font = { color: { argb: 'FFDC2626' } };
    if (d.status === 'weekend') row.font = { color: { argb: 'FF9CA3AF' } };
  });
  const totalRow = ws.getRow(headRow + r.rows.length + 1);
  totalRow.values = ['TOTAL', '', '', '', hoursOf(r.summary.totalWorkedMs), hoursOf(r.summary.totalBreakMs), r.summary.updates, ''];
  totalRow.font = { bold: true };

  const tws = wb.addWorksheet('Tasks');
  tws.columns = [
    { header: 'Task', key: 'title', width: 50 },
    { header: 'Priority', key: 'priority', width: 12 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Deadline', key: 'deadline', width: 20 },
  ];
  styleHeader(tws.getRow(1));
  r.tasks.forEach((t) => tws.addRow({ ...t, deadline: t.deadline.toISOString().slice(0, 16).replace('T', ' ') }));

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function consolidatedExcel(reports: MonthlyReport[], month: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Summary');
  ws.columns = [
    { header: 'Employee ID', key: 'id', width: 13 },
    { header: 'Name', key: 'name', width: 26 },
    { header: 'Department', key: 'dept', width: 20 },
    { header: 'Days present', key: 'present', width: 13 },
    { header: 'Half days', key: 'half', width: 11 },
    { header: 'Days absent', key: 'absent', width: 12 },
    { header: 'Working hrs', key: 'worked', width: 13 },
    { header: 'Break hrs', key: 'brk', width: 11 },
    { header: 'Updates', key: 'updates', width: 10 },
    { header: 'Tasks assigned', key: 'ta', width: 15 },
    { header: 'Tasks completed', key: 'tc', width: 16 },
    { header: 'Tasks pending', key: 'tp', width: 14 },
  ];
  styleHeader(ws.getRow(1));
  reports.forEach((r) =>
    ws.addRow({
      id: r.employee.employeeId, name: r.employee.name, dept: r.employee.department,
      present: r.summary.daysPresent, half: r.summary.halfDays, absent: r.summary.daysAbsent,
      worked: hoursOf(r.summary.totalWorkedMs), brk: hoursOf(r.summary.totalBreakMs), updates: r.summary.updates,
      ta: r.summary.tasksAssigned, tc: r.summary.tasksCompleted, tp: r.summary.tasksPending,
    }),
  );
  const tot = ws.addRow({
    name: `TOTAL — ${monthLabel(month)}`,
    worked: hoursOf(reports.reduce((s, r) => s + r.summary.totalWorkedMs, 0)),
    brk: hoursOf(reports.reduce((s, r) => s + r.summary.totalBreakMs, 0)),
    updates: reports.reduce((s, r) => s + r.summary.updates, 0),
  });
  tot.font = { bold: true };

  const dws = wb.addWorksheet('Daily detail');
  dws.columns = [{ header: 'Employee ID', key: 'id', width: 13 }, { header: 'Name', key: 'name', width: 24 }, ...DAY_COLS];
  styleHeader(dws.getRow(1));
  reports.forEach((r) =>
    r.rows
      .filter((d) => !['upcoming', 'not_joined'].includes(d.status))
      .forEach((d) =>
        dws.addRow({ id: r.employee.employeeId, name: r.employee.name, ...d, worked: hoursOf(d.workedMs), brk: hoursOf(d.breakMs), status: STATUS_LABEL[d.status] ?? d.status }),
      ),
  );
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ───────────────────────────── PDF ───────────────────────────── */

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function drawTable(doc: PDFKit.PDFDocument, headers: string[], widths: number[], rows: string[][], opts: { rowH?: number; dim?: (i: number) => boolean } = {}) {
  const rowH = opts.rowH ?? 18;
  const left = doc.page.margins.left;
  const bottom = () => doc.page.height - doc.page.margins.bottom - rowH;
  const head = () => {
    const y = doc.y;
    doc.rect(left, y, widths.reduce((a, b) => a + b, 0), rowH).fill('#4f46e5');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    let x = left;
    headers.forEach((h, i) => {
      doc.text(h, x + 4, y + 5, { width: widths[i] - 8, lineBreak: false });
      x += widths[i];
    });
    doc.y = y + rowH;
  };
  head();
  rows.forEach((r, ri) => {
    if (doc.y > bottom()) {
      doc.addPage();
      head();
    }
    const y = doc.y;
    if (ri % 2 === 0) doc.rect(left, y, widths.reduce((a, b) => a + b, 0), rowH).fill('#f3f4f6');
    doc.fillColor(opts.dim?.(ri) ? '#9ca3af' : '#111827').font('Helvetica').fontSize(8);
    let x = left;
    r.forEach((c, i) => {
      doc.text(c, x + 4, y + 5, { width: widths[i] - 8, lineBreak: false, ellipsis: true });
      x += widths[i];
    });
    doc.y = y + rowH;
  });
}

export async function monthlyPdf(r: MonthlyReport): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  doc.fillColor('#4f46e5').font('Helvetica-Bold').fontSize(18).text('Monthly Work Report');
  doc.fillColor('#6b7280').font('Helvetica').fontSize(10).text(r.label);
  doc.moveDown(0.8);

  const infoY = doc.y;
  const col = (x: number, pairs: [string, string][]) => {
    let y = infoY;
    pairs.forEach(([k, v]) => {
      doc.fillColor('#6b7280').font('Helvetica').fontSize(8).text(k, x, y);
      doc.fillColor('#111827').font('Helvetica-Bold').fontSize(10).text(v, x, y + 10);
      y += 28;
    });
  };
  col(36, [['Employee', r.employee.name], ['Employee ID', r.employee.employeeId], ['Department', r.employee.department]]);
  col(210, [
    ['Total working hours', fmtDuration(r.summary.totalWorkedMs)],
    ['Total break hours', fmtDuration(r.summary.totalBreakMs)],
    ['Updates submitted', String(r.summary.updates)],
  ]);
  col(390, [
    ['Present / Half / Absent', `${r.summary.daysPresent} / ${r.summary.halfDays} / ${r.summary.daysAbsent}`],
    ['Tasks assigned / done', `${r.summary.tasksAssigned} / ${r.summary.tasksCompleted}`],
    ['Tasks pending', String(r.summary.tasksPending)],
  ]);
  doc.y = infoY + 94;

  const widths = [62, 34, 52, 62, 66, 60, 54, 70];
  drawTable(
    doc,
    ['Date', 'Day', 'Start', 'End', 'Working', 'Break', 'Updates', 'Status'],
    widths,
    r.rows.map((d) => [d.date, d.weekday, d.start, d.end, d.workedMs ? fmtDuration(d.workedMs) : '', d.breakMs ? fmtDuration(d.breakMs) : '', d.updates ? String(d.updates) : '', STATUS_LABEL[d.status] ?? d.status]),
    { rowH: 17, dim: (i) => ['weekend', 'upcoming', 'not_joined'].includes(r.rows[i].status) },
  );
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(9).text(`Monthly total working hours: ${fmtDuration(r.summary.totalWorkedMs)} (${hoursOf(r.summary.totalWorkedMs)} h)   |   Daily target: ${hoursOf(TARGET_MS)} h`, 36, doc.y + 10);

  if (r.tasks.length) {
    doc.moveDown(1.5);
    doc.font('Helvetica-Bold').fontSize(11).text('Tasks');
    doc.moveDown(0.3);
    drawTable(doc, ['Task', 'Priority', 'Status', 'Deadline'], [260, 70, 80, 120], r.tasks.map((t) => [t.title, t.priority, t.status.replace('_', ' '), t.deadline.toISOString().slice(0, 16).replace('T', ' ')]));
  }
  doc.fillColor('#9ca3af').font('Helvetica').fontSize(7).text(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, 36, doc.page.height - 30, { lineBreak: false });
  return collect(doc);
}

export async function consolidatedPdf(reports: MonthlyReport[], month: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  doc.fillColor('#4f46e5').font('Helvetica-Bold').fontSize(18).text('Consolidated Work Report');
  doc.fillColor('#6b7280').font('Helvetica').fontSize(10).text(`${monthLabel(month)} — ${reports.length} employees`);
  doc.moveDown(0.8);
  drawTable(
    doc,
    ['ID', 'Name', 'Department', 'Present', 'Half', 'Absent', 'Working', 'Break', 'Updates', 'Assigned', 'Done', 'Pending'],
    [58, 130, 100, 48, 40, 46, 62, 56, 50, 52, 44, 50],
    reports.map((r) => [
      r.employee.employeeId, r.employee.name, r.employee.department,
      String(r.summary.daysPresent), String(r.summary.halfDays), String(r.summary.daysAbsent),
      fmtDuration(r.summary.totalWorkedMs), fmtDuration(r.summary.totalBreakMs), String(r.summary.updates),
      String(r.summary.tasksAssigned), String(r.summary.tasksCompleted), String(r.summary.tasksPending),
    ]),
  );
  return collect(doc);
}
