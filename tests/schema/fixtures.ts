import { prisma } from './helpers';

export interface SeedCtx {
  clientId: string;
  productId: string;
  product2Id: string;
  userId: string;
  orderId: string;
  orderItemId: string;
  orderNumber: string;
}

export async function seedBase(): Promise<SeedCtx> {
  const client = await prisma.client.create({
    data: { name: 'شركة الاختبار' },
  });
  const p1 = await prisma.product.create({
    data: { name: 'منتج أ', unit: 'قطعة', stock: 100 },
  });
  const p2 = await prisma.product.create({
    data: { name: 'منتج ب', unit: 'قطعة', stock: 50 },
  });
  const user = await prisma.user.create({
    data: {
      email: `test-${Date.now()}@example.com`,
      password: 'hash',
      firstName: 'Test',
      lastName: 'User',
      role: 'manager',
    },
  });
  const orderNumber = `SO-202607-${String(Date.now()).slice(-6)}`;
  const order = await prisma.salesOrder.create({
    data: {
      orderNumber,
      clientId: client.id,
      createdBy: user.id,
      items: {
        create: [
          {
            productId: p1.id,
            orderedQty: 10,
            sellingPrice: 100,
            productName: p1.name,
          },
          {
            productId: p2.id,
            orderedQty: 5,
            sellingPrice: 50,
            productName: p2.name,
          },
        ],
      },
    },
    include: { items: true },
  });

  return {
    clientId: client.id,
    productId: p1.id,
    product2Id: p2.id,
    userId: user.id,
    orderId: order.id,
    orderItemId: order.items[0].id,
    orderNumber,
  };
}

export async function cleanDb(): Promise<void> {
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
}
