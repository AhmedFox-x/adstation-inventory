import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";
import { generateUniqueBarcode } from "../utils/barcode";

const router = Router();

// ── GET /api/inventory/products/barcode/:barcode — lookup product by barcode ──
router.get("/products/barcode/:barcode", requireAuth, async (req, res) => {
  try {
    const { barcode } = req.params;
    if (!barcode || barcode.trim().length === 0) {
      res.status(400).json({ error: "Barcode is required" });
      return;
    }

    const product = await prisma.product.findFirst({
      where: { barcode: barcode.trim(), deletedAt: null },
      select: {
        id: true,
        name: true,
        variant: true,
        stock: true,
        minStock: true,
        sku: true,
        barcode: true,
        category: true,
        price: true,
        imageUrl: true,
      },
    });

    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    res.json(product);
  } catch (err: any) {
    console.error("[Barcode Lookup] Error:", err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to lookup product" });
    }
  }
});

// ── POST /api/inventory/products/:id/regenerate-barcode — new barcode for product ──
router.post("/products/:id/regenerate-barcode", requireAuth, requirePermission("products.edit"), async (req: AuthRequest, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    if (product.deletedAt) {
      res.status(403).json({ error: "Archived products cannot be modified" });
      return;
    }

    const newBarcode = await generateUniqueBarcode();
    await prisma.product.update({
      where: { id: req.params.id },
      data: { barcode: newBarcode },
    });

    res.json({ barcode: newBarcode });
  } catch (err: any) {
    console.error("[Barcode Regenerate] Error:", err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to regenerate barcode" });
    }
  }
});

// ── POST /api/inventory/products/seed-barcodes — assign barcodes to all products without one ──
router.post("/products/seed-barcodes", requireAuth, requirePermission("products.edit"), async (req: AuthRequest, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { barcode: null, deletedAt: null },
      select: { id: true },
    });

    if (products.length === 0) {
      res.json({ message: "All products already have barcodes", count: 0 });
      return;
    }

    let count = 0;
    for (const p of products) {
      const barcode = await generateUniqueBarcode();
      await prisma.product.update({
        where: { id: p.id },
        data: { barcode },
      });
      count++;
    }

    res.json({ message: `Assigned barcodes to ${count} products`, count });
  } catch (err: any) {
    console.error("[Barcode Seed] Error:", err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to seed barcodes" });
    }
  }
});

export default router;
