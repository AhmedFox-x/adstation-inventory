import { Request, Response, NextFunction } from "express";
export interface AuthRequest extends Request {
    user?: {
        userId: string;
        email: string;
        name?: string;
        role?: string;
        permissions?: string[];
    };
}
export declare function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void;
export declare function requirePermission(...perms: string[]): (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>;
export declare function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction): void;
//# sourceMappingURL=auth.d.ts.map