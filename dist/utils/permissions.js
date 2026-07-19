"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ROLES = exports.ALL_PERMISSIONS = exports.PERMISSIONS = void 0;
exports.PERMISSIONS = {
    PRODUCTS_VIEW: 'products.view',
    PRODUCTS_CREATE: 'products.create',
    PRODUCTS_EDIT: 'products.edit',
    PRODUCTS_DELETE: 'products.delete',
    PERMITS_WITHDRAW: 'permits.withdraw',
    PERMITS_SUPPLY: 'permits.supply',
    SCAN_USE: 'scan.use',
    LOGS_VIEW: 'logs.view',
    LOGS_DELETE: 'logs.delete',
    REPORTS_VIEW: 'reports.view',
    REPORTS_EXPORT: 'reports.export',
    USERS_VIEW: 'users.view',
    USERS_MANAGE: 'users.manage',
    ROLES_VIEW: 'roles.view',
    ROLES_EDIT: 'roles.edit',
};
exports.ALL_PERMISSIONS = Object.values(exports.PERMISSIONS);
exports.DEFAULT_ROLES = {
    owner: {
        displayName: 'المالك',
        description: 'صلاحيات كاملة على النظام — إدارة المستخدمين والصلاحيات والمخزون والتقارير',
        permissions: exports.ALL_PERMISSIONS,
    },
    manager: {
        displayName: 'مدير',
        description: 'إدارة المنتجات والtorid والصرف والمسح والتقارير — لا يستطيع إدارة المستخدمين',
        permissions: [
            exports.PERMISSIONS.PRODUCTS_VIEW,
            exports.PERMISSIONS.PRODUCTS_CREATE,
            exports.PERMISSIONS.PRODUCTS_EDIT,
            exports.PERMISSIONS.PRODUCTS_DELETE,
            exports.PERMISSIONS.PERMITS_WITHDRAW,
            exports.PERMISSIONS.PERMITS_SUPPLY,
            exports.PERMISSIONS.SCAN_USE,
            exports.PERMISSIONS.LOGS_VIEW,
            exports.PERMISSIONS.REPORTS_VIEW,
            exports.PERMISSIONS.REPORTS_EXPORT,
        ],
    },
    viewer: {
        displayName: 'متابع',
        description: 'عرض المخزون والتقارير فقط — لا يستطيع التعديل أو الإنشاء',
        permissions: [
            exports.PERMISSIONS.PRODUCTS_VIEW,
            exports.PERMISSIONS.LOGS_VIEW,
            exports.PERMISSIONS.REPORTS_VIEW,
            exports.PERMISSIONS.REPORTS_EXPORT,
        ],
    },
};
//# sourceMappingURL=permissions.js.map