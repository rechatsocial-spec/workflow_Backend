import 'express';

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; role: 'admin' | 'employee'; email: string; name: string };
      /** loaded for employee-role requests by `loadEmployee` */
      employee?: { _id: any; employeeId: string; name: string; department: string; user: any };
    }
  }
}
export {};
