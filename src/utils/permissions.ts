export const PERMISSIONS = {
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
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

export const DEFAULT_ROLES: Record<string, { displayName: string; description: string; permissions: Permission[] }> = {
  owner: {
    displayName: 'المالك',
    description: 'صلاحيات كاملة على النظام — إدارة المستخدمين والصلاحيات والمخزون والتقارير',
    permissions: ALL_PERMISSIONS,
  },
  manager: {
    displayName: 'مدير',
    description: 'إدارة المنتجات والtorid والصرف والمسح والتقارير — لا يستطيع إدارة المستخدمين',
    permissions: [
      PERMISSIONS.PRODUCTS_VIEW,
      PERMISSIONS.PRODUCTS_CREATE,
      PERMISSIONS.PRODUCTS_EDIT,
      PERMISSIONS.PRODUCTS_DELETE,
      PERMISSIONS.PERMITS_WITHDRAW,
      PERMISSIONS.PERMITS_SUPPLY,
      PERMISSIONS.SCAN_USE,
      PERMISSIONS.LOGS_VIEW,
      PERMISSIONS.REPORTS_VIEW,
      PERMISSIONS.REPORTS_EXPORT,
    ],
  },
  viewer: {
    displayName: 'متابع',
    description: 'عرض المخزون والتقارير فقط — لا يستطيع التعديل أو الإنشاء',
    permissions: [
      PERMISSIONS.PRODUCTS_VIEW,
      PERMISSIONS.LOGS_VIEW,
      PERMISSIONS.REPORTS_VIEW,
      PERMISSIONS.REPORTS_EXPORT,
    ],
  },
};
