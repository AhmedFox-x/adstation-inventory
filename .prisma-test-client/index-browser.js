
Object.defineProperty(exports, "__esModule", { value: true });

const {
  Decimal,
  objectEnumValues,
  makeStrictEnum,
  Public,
  getRuntime,
  skip
} = require('./runtime/index-browser.js')


const Prisma = {}

exports.Prisma = Prisma
exports.$Enums = {}

/**
 * Prisma Client JS version: 5.22.0
 * Query Engine version: 605197351a3c8bdd595af2d2a9bc3025bca48ea2
 */
Prisma.prismaVersion = {
  client: "5.22.0",
  engine: "605197351a3c8bdd595af2d2a9bc3025bca48ea2"
}

Prisma.PrismaClientKnownRequestError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientKnownRequestError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)};
Prisma.PrismaClientUnknownRequestError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientUnknownRequestError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientRustPanicError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientRustPanicError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientInitializationError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientInitializationError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientValidationError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientValidationError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.NotFoundError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`NotFoundError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.Decimal = Decimal

/**
 * Re-export of sql-template-tag
 */
Prisma.sql = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`sqltag is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.empty = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`empty is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.join = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`join is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.raw = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`raw is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.validator = Public.validator

/**
* Extensions
*/
Prisma.getExtensionContext = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`Extensions.getExtensionContext is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.defineExtension = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`Extensions.defineExtension is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}

/**
 * Shorthand utilities for JSON filtering
 */
Prisma.DbNull = objectEnumValues.instances.DbNull
Prisma.JsonNull = objectEnumValues.instances.JsonNull
Prisma.AnyNull = objectEnumValues.instances.AnyNull

Prisma.NullTypes = {
  DbNull: objectEnumValues.classes.DbNull,
  JsonNull: objectEnumValues.classes.JsonNull,
  AnyNull: objectEnumValues.classes.AnyNull
}



/**
 * Enums
 */

exports.Prisma.TransactionIsolationLevel = makeStrictEnum({
  ReadUncommitted: 'ReadUncommitted',
  ReadCommitted: 'ReadCommitted',
  RepeatableRead: 'RepeatableRead',
  Serializable: 'Serializable'
});

exports.Prisma.SystemSettingsScalarFieldEnum = {
  id: 'id',
  key: 'key',
  value: 'value',
  updatedAt: 'updatedAt'
};

exports.Prisma.RoleConfigScalarFieldEnum = {
  id: 'id',
  name: 'name',
  displayName: 'displayName',
  description: 'description',
  permissions: 'permissions',
  isSystem: 'isSystem',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.UserScalarFieldEnum = {
  id: 'id',
  email: 'email',
  password: 'password',
  firstName: 'firstName',
  lastName: 'lastName',
  title: 'title',
  department: 'department',
  position: 'position',
  role: 'role',
  roleId: 'roleId',
  createdAt: 'createdAt'
};

exports.Prisma.ProductScalarFieldEnum = {
  id: 'id',
  name: 'name',
  variant: 'variant',
  unit: 'unit',
  stock: 'stock',
  reservedStock: 'reservedStock',
  quarantineStock: 'quarantineStock',
  minStock: 'minStock',
  sku: 'sku',
  barcode: 'barcode',
  category: 'category',
  brand: 'brand',
  price: 'price',
  imageUrl: 'imageUrl',
  deletedAt: 'deletedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.ReservationScalarFieldEnum = {
  id: 'id',
  productId: 'productId',
  clientId: 'clientId',
  salesOrderItemId: 'salesOrderItemId',
  warehouseId: 'warehouseId',
  quantity: 'quantity',
  fulfilledQty: 'fulfilledQty',
  status: 'status',
  notes: 'notes',
  expiresAt: 'expiresAt',
  createdBy: 'createdBy',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.WithdrawalPermitScalarFieldEnum = {
  id: 'id',
  permitNumber: 'permitNumber',
  clientName: 'clientName',
  clientId: 'clientId',
  salesName: 'salesName',
  operationType: 'operationType',
  notes: 'notes',
  status: 'status',
  imageBase64: 'imageBase64',
  imageMimeType: 'imageMimeType',
  orderDate: 'orderDate',
  deliveryDate: 'deliveryDate',
  permitNumberOrig: 'permitNumberOrig',
  createdAt: 'createdAt'
};

exports.Prisma.WithdrawalItemScalarFieldEnum = {
  id: 'id',
  permitId: 'permitId',
  productId: 'productId',
  quantityRequested: 'quantityRequested',
  quantityActual: 'quantityActual',
  matchConfidence: 'matchConfidence'
};

exports.Prisma.SupplyPermitScalarFieldEnum = {
  id: 'id',
  permitNumber: 'permitNumber',
  supplierName: 'supplierName',
  supplierId: 'supplierId',
  salesName: 'salesName',
  clientName: 'clientName',
  notes: 'notes',
  imageBase64: 'imageBase64',
  imageMimeType: 'imageMimeType',
  orderDate: 'orderDate',
  deliveryDate: 'deliveryDate',
  permitNumberOrig: 'permitNumberOrig',
  createdAt: 'createdAt'
};

exports.Prisma.SupplyItemScalarFieldEnum = {
  id: 'id',
  permitId: 'permitId',
  productId: 'productId',
  quantity: 'quantity'
};

exports.Prisma.InventoryLogScalarFieldEnum = {
  id: 'id',
  type: 'type',
  productId: 'productId',
  warehouseId: 'warehouseId',
  oldStock: 'oldStock',
  newStock: 'newStock',
  change: 'change',
  clientName: 'clientName',
  salesName: 'salesName',
  notes: 'notes',
  referenceType: 'referenceType',
  referenceId: 'referenceId',
  userId: 'userId',
  userName: 'userName',
  userRole: 'userRole',
  entityType: 'entityType',
  entityId: 'entityId',
  beforeData: 'beforeData',
  afterData: 'afterData',
  createdAt: 'createdAt'
};

exports.Prisma.StocktakeSessionScalarFieldEnum = {
  id: 'id',
  name: 'name',
  status: 'status',
  warehouseId: 'warehouseId',
  userId: 'userId',
  userName: 'userName',
  date: 'date',
  notes: 'notes',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.StocktakeItemScalarFieldEnum = {
  id: 'id',
  sessionId: 'sessionId',
  productId: 'productId',
  productName: 'productName',
  productSku: 'productSku',
  productVariant: 'productVariant',
  category: 'category',
  systemStock: 'systemStock',
  actualCount: 'actualCount',
  note: 'note',
  exclusionReason: 'exclusionReason',
  flaggedRecount: 'flaggedRecount'
};

exports.Prisma.SupplierScalarFieldEnum = {
  id: 'id',
  name: 'name',
  phone: 'phone',
  email: 'email',
  address: 'address',
  paymentTerms: 'paymentTerms',
  notes: 'notes',
  isActive: 'isActive',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.ClientScalarFieldEnum = {
  id: 'id',
  name: 'name',
  phone: 'phone',
  email: 'email',
  address: 'address',
  notes: 'notes',
  isActive: 'isActive',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.PurchaseOrderScalarFieldEnum = {
  id: 'id',
  orderNumber: 'orderNumber',
  supplierId: 'supplierId',
  status: 'status',
  orderDate: 'orderDate',
  expectedDeliveryDate: 'expectedDeliveryDate',
  actualDeliveryDate: 'actualDeliveryDate',
  totalAmount: 'totalAmount',
  subtotal: 'subtotal',
  discount: 'discount',
  shipping: 'shipping',
  taxAmount: 'taxAmount',
  grandTotal: 'grandTotal',
  currency: 'currency',
  notes: 'notes',
  createdBy: 'createdBy',
  approvedBy: 'approvedBy',
  approvedAt: 'approvedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.PurchaseOrderItemScalarFieldEnum = {
  id: 'id',
  orderId: 'orderId',
  productId: 'productId',
  quantity: 'quantity',
  unitPrice: 'unitPrice',
  totalPrice: 'totalPrice',
  discount: 'discount',
  tax: 'tax',
  receivedQuantity: 'receivedQuantity',
  acceptedQty: 'acceptedQty',
  rejectedQty: 'rejectedQty'
};

exports.Prisma.PurchaseOrderStatusHistoryScalarFieldEnum = {
  id: 'id',
  orderId: 'orderId',
  fromStatus: 'fromStatus',
  toStatus: 'toStatus',
  changedBy: 'changedBy',
  note: 'note',
  createdAt: 'createdAt'
};

exports.Prisma.SalesOrderScalarFieldEnum = {
  id: 'id',
  orderNumber: 'orderNumber',
  clientId: 'clientId',
  reference: 'reference',
  status: 'status',
  orderDate: 'orderDate',
  expectedDeliveryDate: 'expectedDeliveryDate',
  actualDeliveryDate: 'actualDeliveryDate',
  expiresAt: 'expiresAt',
  subtotal: 'subtotal',
  discount: 'discount',
  shipping: 'shipping',
  taxAmount: 'taxAmount',
  grandTotal: 'grandTotal',
  currency: 'currency',
  notes: 'notes',
  createdBy: 'createdBy',
  version: 'version',
  deletedAt: 'deletedAt',
  deletedBy: 'deletedBy',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.SalesOrderItemScalarFieldEnum = {
  id: 'id',
  orderId: 'orderId',
  productId: 'productId',
  orderedQty: 'orderedQty',
  deliveredQty: 'deliveredQty',
  costPrice: 'costPrice',
  sellingPrice: 'sellingPrice',
  totalPrice: 'totalPrice',
  discount: 'discount',
  tax: 'tax',
  taxRate: 'taxRate',
  discountRate: 'discountRate',
  currency: 'currency',
  exchangeRate: 'exchangeRate',
  productName: 'productName',
  productSku: 'productSku',
  unit: 'unit',
  barcode: 'barcode',
  category: 'category',
  brand: 'brand'
};

exports.Prisma.SalesOrderApprovalScalarFieldEnum = {
  id: 'id',
  salesOrderId: 'salesOrderId',
  status: 'status',
  requestedBy: 'requestedBy',
  approvedBy: 'approvedBy',
  rejectedBy: 'rejectedBy',
  reason: 'reason',
  createdAt: 'createdAt',
  approvedAt: 'approvedAt',
  rejectedAt: 'rejectedAt'
};

exports.Prisma.SalesOrderStatusHistoryScalarFieldEnum = {
  id: 'id',
  orderId: 'orderId',
  fromStatus: 'fromStatus',
  toStatus: 'toStatus',
  changedBy: 'changedBy',
  note: 'note',
  ip: 'ip',
  userAgent: 'userAgent',
  beforeState: 'beforeState',
  afterState: 'afterState',
  changedFields: 'changedFields',
  createdAt: 'createdAt'
};

exports.Prisma.SalesDeliveryScalarFieldEnum = {
  id: 'id',
  salesOrderId: 'salesOrderId',
  deliveryNumber: 'deliveryNumber',
  deliveredAt: 'deliveredAt',
  deliveredBy: 'deliveredBy',
  driverName: 'driverName',
  vehicle: 'vehicle',
  proofImage: 'proofImage',
  signature: 'signature',
  gpsLocation: 'gpsLocation',
  notes: 'notes',
  createdAt: 'createdAt'
};

exports.Prisma.SalesDeliveryItemScalarFieldEnum = {
  id: 'id',
  deliveryId: 'deliveryId',
  salesOrderItemId: 'salesOrderItemId',
  productId: 'productId',
  quantity: 'quantity',
  unit: 'unit'
};

exports.Prisma.NotificationScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  type: 'type',
  title: 'title',
  message: 'message',
  entityType: 'entityType',
  entityId: 'entityId',
  referenceType: 'referenceType',
  referenceId: 'referenceId',
  priority: 'priority',
  icon: 'icon',
  actionUrl: 'actionUrl',
  createdBySystem: 'createdBySystem',
  isRead: 'isRead',
  readAt: 'readAt',
  deletedAt: 'deletedAt',
  createdAt: 'createdAt'
};

exports.Prisma.ReturnOrderScalarFieldEnum = {
  id: 'id',
  returnNumber: 'returnNumber',
  type: 'type',
  sourceType: 'sourceType',
  sourceId: 'sourceId',
  sourceNumber: 'sourceNumber',
  partyId: 'partyId',
  partyName: 'partyName',
  status: 'status',
  warehouseDestination: 'warehouseDestination',
  subtotal: 'subtotal',
  refundAmount: 'refundAmount',
  currency: 'currency',
  notes: 'notes',
  images: 'images',
  createdBy: 'createdBy',
  approvedBy: 'approvedBy',
  approvedAt: 'approvedAt',
  rejectedBy: 'rejectedBy',
  rejectedAt: 'rejectedAt',
  rejectionReason: 'rejectionReason',
  receivedBy: 'receivedBy',
  receivedAt: 'receivedAt',
  closedBy: 'closedBy',
  closedAt: 'closedAt',
  refundStatus: 'refundStatus',
  refundDate: 'refundDate',
  refundNote: 'refundNote',
  refundDueAt: 'refundDueAt',
  resolution: 'resolution',
  replacementOrderId: 'replacementOrderId',
  version: 'version',
  deletedAt: 'deletedAt',
  deletedBy: 'deletedBy',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.ReturnOrderItemScalarFieldEnum = {
  id: 'id',
  returnId: 'returnId',
  sourceItemId: 'sourceItemId',
  productId: 'productId',
  productName: 'productName',
  productSku: 'productSku',
  unit: 'unit',
  condition: 'condition',
  reason: 'reason',
  returnedQty: 'returnedQty',
  receivedQty: 'receivedQty',
  unitPrice: 'unitPrice',
  totalPrice: 'totalPrice',
  imageBefore: 'imageBefore',
  imageAfter: 'imageAfter',
  notes: 'notes'
};

exports.Prisma.ReturnOrderStatusHistoryScalarFieldEnum = {
  id: 'id',
  returnId: 'returnId',
  fromStatus: 'fromStatus',
  toStatus: 'toStatus',
  changedBy: 'changedBy',
  note: 'note',
  ip: 'ip',
  userAgent: 'userAgent',
  beforeState: 'beforeState',
  afterState: 'afterState',
  changedFields: 'changedFields',
  createdAt: 'createdAt'
};

exports.Prisma.WarehouseScalarFieldEnum = {
  id: 'id',
  name: 'name',
  type: 'type',
  description: 'description',
  isActive: 'isActive',
  deletedAt: 'deletedAt',
  deletedBy: 'deletedBy',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.WarehouseStockScalarFieldEnum = {
  id: 'id',
  warehouseId: 'warehouseId',
  productId: 'productId',
  quantity: 'quantity',
  reservedQuantity: 'reservedQuantity',
  updatedAt: 'updatedAt'
};

exports.Prisma.TransferScalarFieldEnum = {
  id: 'id',
  transferNumber: 'transferNumber',
  fromWarehouseId: 'fromWarehouseId',
  toWarehouseId: 'toWarehouseId',
  status: 'status',
  notes: 'notes',
  createdBy: 'createdBy',
  createdByName: 'createdByName',
  executedBy: 'executedBy',
  executedByName: 'executedByName',
  executedAt: 'executedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.TransferItemScalarFieldEnum = {
  id: 'id',
  transferId: 'transferId',
  productId: 'productId',
  quantity: 'quantity'
};

exports.Prisma.SortOrder = {
  asc: 'asc',
  desc: 'desc'
};

exports.Prisma.NullableJsonNullValueInput = {
  DbNull: Prisma.DbNull,
  JsonNull: Prisma.JsonNull
};

exports.Prisma.QueryMode = {
  default: 'default',
  insensitive: 'insensitive'
};

exports.Prisma.NullsOrder = {
  first: 'first',
  last: 'last'
};

exports.Prisma.JsonNullValueFilter = {
  DbNull: Prisma.DbNull,
  JsonNull: Prisma.JsonNull,
  AnyNull: Prisma.AnyNull
};


exports.Prisma.ModelName = {
  SystemSettings: 'SystemSettings',
  RoleConfig: 'RoleConfig',
  User: 'User',
  Product: 'Product',
  Reservation: 'Reservation',
  WithdrawalPermit: 'WithdrawalPermit',
  WithdrawalItem: 'WithdrawalItem',
  SupplyPermit: 'SupplyPermit',
  SupplyItem: 'SupplyItem',
  InventoryLog: 'InventoryLog',
  StocktakeSession: 'StocktakeSession',
  StocktakeItem: 'StocktakeItem',
  Supplier: 'Supplier',
  Client: 'Client',
  PurchaseOrder: 'PurchaseOrder',
  PurchaseOrderItem: 'PurchaseOrderItem',
  PurchaseOrderStatusHistory: 'PurchaseOrderStatusHistory',
  SalesOrder: 'SalesOrder',
  SalesOrderItem: 'SalesOrderItem',
  SalesOrderApproval: 'SalesOrderApproval',
  SalesOrderStatusHistory: 'SalesOrderStatusHistory',
  SalesDelivery: 'SalesDelivery',
  SalesDeliveryItem: 'SalesDeliveryItem',
  Notification: 'Notification',
  ReturnOrder: 'ReturnOrder',
  ReturnOrderItem: 'ReturnOrderItem',
  ReturnOrderStatusHistory: 'ReturnOrderStatusHistory',
  Warehouse: 'Warehouse',
  WarehouseStock: 'WarehouseStock',
  Transfer: 'Transfer',
  TransferItem: 'TransferItem'
};

/**
 * This is a stub Prisma Client that will error at runtime if called.
 */
class PrismaClient {
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        let message
        const runtime = getRuntime()
        if (runtime.isEdge) {
          message = `PrismaClient is not configured to run in ${runtime.prettyName}. In order to run Prisma Client on edge runtime, either:
- Use Prisma Accelerate: https://pris.ly/d/accelerate
- Use Driver Adapters: https://pris.ly/d/driver-adapters
`;
        } else {
          message = 'PrismaClient is unable to run in this browser environment, or has been bundled for the browser (running in `' + runtime.prettyName + '`).'
        }
        
        message += `
If this is unexpected, please open an issue: https://pris.ly/prisma-prisma-bug-report`

        throw new Error(message)
      }
    })
  }
}

exports.PrismaClient = PrismaClient

Object.assign(exports, Prisma)
