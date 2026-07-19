import { Request, Response, NextFunction } from "express";
export declare function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void;
export declare function notFound(_req: Request, res: Response): void;
export declare function createError(message: string, status: number): any;
//# sourceMappingURL=errorHandler.d.ts.map