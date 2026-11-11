import { Response, Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAdmin } from '../middleware/auth';
import { Employee } from '../models/employee.model';
import { audit } from '../services/audit.service';
import { buildMonthlyReports, consolidatedExcel, consolidatedPdf, monthlyExcel, monthlyPdf } from '../services/report.service';
import { ApiError, asyncHandler, monthStr, objectId, validate } from '../utils/http';
import { dateKey } from '../utils/time';

const router = Router();
router.use(authenticate);

const MIME = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

function send(res: Response, format: 'pdf' | 'xlsx', filename: string, buf: Buffer) {
  res.setHeader('Content-Type', MIME[format]);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.${format}"`);
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.end(buf);
}

/**
 * Employee: always their OWN report (employeeId ignored).
 * Admin: must pass employeeId.
 */
router.get(
  '/monthly',
  validate({
    query: z.object({
      month: monthStr.default(dateKey().slice(0, 7)),
      format: z.enum(['pdf', 'xlsx']).default('pdf'),
      employeeId: objectId.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { month, format, employeeId } = req.query as any;
    let target: unknown;
    if (req.user!.role === 'employee') {
      const me = await Employee.findOne({ user: req.user!.id }).select('_id').lean();
      if (!me) throw new ApiError(403, 'Employee profile not found');
      target = me._id;
    } else {
      if (!employeeId) throw new ApiError(400, 'employeeId is required');
      target = employeeId;
    }
    const [report] = await buildMonthlyReports([target], month);
    if (!report) throw new ApiError(404, 'Employee not found');
    const buf = format === 'pdf' ? await monthlyPdf(report) : await monthlyExcel(report);
    await audit({ req, action: 'REPORT_DOWNLOADED', entityType: 'Employee', entityId: target, metadata: { month, format } });
    send(res, format, `report-${report.employee.employeeId}-${month}`, buf);
  }),
);

router.get(
  '/consolidated',
  requireAdmin,
  validate({
    query: z.object({
      month: monthStr.default(dateKey().slice(0, 7)),
      format: z.enum(['pdf', 'xlsx']).default('xlsx'),
      department: z.string().trim().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { month, format, department } = req.query as any;
    const ids = await Employee.find(department ? { department } : {}).distinct('_id');
    const reports = await buildMonthlyReports(ids, month);
    const buf = format === 'pdf' ? await consolidatedPdf(reports, month) : await consolidatedExcel(reports, month);
    await audit({ req, action: 'CONSOLIDATED_REPORT_DOWNLOADED', metadata: { month, format, department, employees: reports.length } });
    send(res, format, `consolidated-report-${month}`, buf);
  }),
);

export default router;
