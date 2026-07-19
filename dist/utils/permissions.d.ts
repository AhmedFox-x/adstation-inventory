export declare const PERMISSIONS: {
    readonly PRODUCTS_VIEW: "products.view";
    readonly PRODUCTS_CREATE: "products.create";
    readonly PRODUCTS_EDIT: "products.edit";
    readonly PRODUCTS_DELETE: "products.delete";
    readonly PERMITS_WITHDRAW: "permits.withdraw";
    readonly PERMITS_SUPPLY: "permits.supply";
    readonly SCAN_USE: "scan.use";
    readonly LOGS_VIEW: "logs.view";
    readonly LOGS_DELETE: "logs.delete";
    readonly REPORTS_VIEW: "reports.view";
    readonly REPORTS_EXPORT: "reports.export";
    readonly USERS_VIEW: "users.view";
    readonly USERS_MANAGE: "users.manage";
    readonly ROLES_VIEW: "roles.view";
    readonly ROLES_EDIT: "roles.edit";
};
export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export declare const ALL_PERMISSIONS: Permission[];
export declare const DEFAULT_ROLES: Record<string, {
    displayName: string;
    description: string;
    permissions: Permission[];
}>;
//# sourceMappingURL=permissions.d.ts.map