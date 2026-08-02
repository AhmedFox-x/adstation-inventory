import { resetTestDb, applyMigrations, isSchemaApplied, prisma } from './tests/schema/helpers';

export default async function globalSetup(): Promise<void> {
  const applied = await isSchemaApplied();
  if (applied) {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        "SystemSettings",
        "RoleConfig",
        "Client",
        "User",
        "Product",
        "Supplier",
        "PurchaseOrder",
        "PurchaseOrderItem",
        "PurchaseOrderStatusHistory",
        "SupplyPermit",
        "SupplyItem",
        "WithdrawalPermit",
        "WithdrawalItem",
        "StocktakeSession",
        "StocktakeItem",
        "InventoryLog",
        "SalesOrder",
        "SalesOrderStatusHistory",
        "SalesOrderItem",
        "SalesOrderApproval",
        "Reservation",
        "Notification",
        "SalesDelivery",
        "SalesDeliveryItem"
        CASCADE
    `);
    return;
  }
  await resetTestDb();
  await applyMigrations();
}
