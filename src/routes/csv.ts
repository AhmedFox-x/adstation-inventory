import { Router } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { prisma } from "../config/database";
import { requireAuth, requirePermission } from "../middleware/auth";
import { importLimiter } from "../middleware/rateLimiter";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".csv", ".xlsx", ".xls"];
    const ext = file.originalname
      .slice(file.originalname.lastIndexOf("."))
      .toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV, XLSX, and XLS files are allowed"));
    }
  },
});

const COLUMN_MAP: Record<string, string> = {
  "اسم المنتج": "name",
  name: "name",
  "النوع": "variant",
  variant: "variant",
  "الكمية": "stock",
  stock: "stock",
  "الحد الأدنى": "minStock",
  minstock: "minStock",
  "الكود": "sku",
  sku: "sku",
  "التصنيف": "category",
  category: "category",
  "السعر": "price",
  price: "price",
};

function normalizeHeader(h: string): string {
  const cleaned = h.replace(/^\uFEFF/, "").replace(/\uFEFF/g, "").trim();
  const lower = cleaned.toLowerCase();
  return COLUMN_MAP[lower] || lower;
}

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          cells.push(current.trim());
          current = "";
        } else {
          current += ch;
        }
      }
    }
    cells.push(current.trim());
    return cells;
  };

  const headerCells = parseLine(lines[0]).map((h) => normalizeHeader(h));
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    const row: Record<string, string> = {};
    headerCells.forEach((h, idx) => {
      row[h] = (vals[idx] || "").replace(/^"|"$/g, "").trim();
    });
    rows.push(row);
  }
  return rows;
}

function parseRows(rows: Record<string, any>[]) {
  const results: {
    data: Record<string, any>[];
    errors: { row: number; message: string }[];
  } = { data: [], errors: [] };

  rows.forEach((raw, idx) => {
    if (!raw.name || !String(raw.name).trim()) {
      results.errors.push({ row: idx + 2, message: "Missing product name" });
      return;
    }

    results.data.push({
      name: String(raw.name).trim(),
      variant: raw.variant ? String(raw.variant).trim() : null,
      stock: raw.stock !== undefined && raw.stock !== "" ? Number(raw.stock) : 0,
      minStock:
        raw.minStock !== undefined && raw.minStock !== ""
          ? Number(raw.minStock)
          : 5,
      sku: raw.sku ? String(raw.sku).trim() : null,
      category: raw.category ? String(raw.category).trim() : null,
      price:
        raw.price !== undefined && raw.price !== "" ? Number(raw.price) : 0,
    });
  });

  return results;
}

// GET /products/import/template
router.get(
  "/products/import/template",
  importLimiter,
  requireAuth,
  requirePermission("products.import"),
  async (_req, res) => {
    const headers = [
      "اسم المنتج",
      "النوع",
      "الكمية",
      "الحد الأدنى",
      "الكود",
      "التصنيف",
      "السعر",
    ];
    const sample = ["قلم حبر", "أحمر", "50", "10", "PEN-RED", "مكتبية", "15.5"];
    const csvContent = [headers.join(","), sample.join(",")].join("\n");
    const buf = Buffer.from("\uFEFF" + csvContent, "utf-8");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=product-template.csv"
    );
    res.send(buf);
  }
);

// GET /products/export
router.get(
  "/products/export",
  requireAuth,
  requirePermission("products.export"),
  async (_req, res) => {
    try {
      const products = await prisma.product.findMany({
        orderBy: { name: "asc" },
      });
      const rows = products.map((p) => ({
        "اسم المنتج": p.name,
        النوع: p.variant || "",
        الكمية: p.stock,
        "الحد الأدنى": p.minStock,
        الكود: p.sku || "",
        التصنيف: p.category || "",
        السعر: p.price || 0,
        الباركود: p.barcode || "",
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [
        { wch: 30 },
        { wch: 15 },
        { wch: 10 },
        { wch: 10 },
        { wch: 15 },
        { wch: 15 },
        { wch: 10 },
        { wch: 15 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Products");
      const csvBuf = XLSX.write(wb, { type: "buffer", bookType: "csv" });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=products-export-${new Date().toISOString().slice(0, 10)}.csv`
      );
      res.send(Buffer.from("\uFEFF" + csvBuf, "utf-8"));
    } catch (err: any) {
      res.status(500).json({ error: "Export failed: " + err.message });
    }
  }
);

// POST /products/import
router.post(
  "/products/import",
  importLimiter,
  requireAuth,
  requirePermission("products.import"),
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }

      const mode = req.body.mode === "update" ? "update" : "create";
      const ext = req.file.originalname
        .slice(req.file.originalname.lastIndexOf("."))
        .toLowerCase();

      let rawRows: Record<string, any>[];

      if (ext === ".csv") {
        const text = req.file.buffer.toString("utf-8");
        rawRows = parseCSV(text);
      } else {
        const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) {
          res.status(400).json({ error: "Spreadsheet has no sheets" });
          return;
        }
        rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
      }

      if (rawRows.length === 0) {
        res.status(400).json({ error: "Spreadsheet is empty" });
        return;
      }

      const { data, errors } = parseRows(rawRows);
      if (data.length === 0) {
        res.status(400).json({ error: "No valid rows found", errors });
        return;
      }

      let created = 0;
      let updated = 0;
      let skipped = 0;
      const importErrors: { row: number; message: string }[] = [...errors];

      if (mode === "create") {
        for (let i = 0; i < data.length; i++) {
          const row = data[i];
          try {
            if (row.sku) {
              const existing = await prisma.product.findUnique({
                where: { sku: row.sku },
              });
              if (existing) {
                skipped++;
                importErrors.push({
                  row: i + 2,
                  message: `SKU "${row.sku}" already exists — skipped`,
                });
                continue;
              }
            }
            await prisma.product.create({
              data: {
                name: row.name,
                variant: row.variant,
                stock: Math.max(0, row.stock),
                minStock: Math.max(1, row.minStock),
                sku: row.sku,
                category: row.category,
                price: Math.max(0, row.price),
              },
            });
            created++;
          } catch (e: any) {
            importErrors.push({
              row: i + 2,
              message: e.message || "Create failed",
            });
            skipped++;
          }
        }
      } else {
        for (let i = 0; i < data.length; i++) {
          const row = data[i];
          try {
            if (!row.sku) {
              importErrors.push({
                row: i + 2,
                message: "No SKU — cannot match for update",
              });
              skipped++;
              continue;
            }
            const existing = await prisma.product.findUnique({
              where: { sku: row.sku },
            });
            if (!existing) {
              importErrors.push({
                row: i + 2,
                message: `SKU "${row.sku}" not found — skipped`,
              });
              skipped++;
              continue;
            }
            const updateData: Record<string, any> = {};
            if (row.name) updateData.name = row.name;
            if (row.variant !== undefined) updateData.variant = row.variant;
            if (row.stock !== undefined && row.stock !== "")
              updateData.stock = Math.max(0, row.stock);
            if (row.minStock !== undefined && row.minStock !== "")
              updateData.minStock = Math.max(1, row.minStock);
            if (row.category !== undefined) updateData.category = row.category;
            if (row.price !== undefined && row.price !== "")
              updateData.price = Math.max(0, row.price);

            await prisma.product.update({
              where: { sku: row.sku },
              data: updateData,
            });
            updated++;
          } catch (e: any) {
            importErrors.push({
              row: i + 2,
              message: e.message || "Update failed",
            });
            skipped++;
          }
        }
      }

      res.json({
        mode,
        total: data.length,
        created,
        updated,
        skipped,
        errors: importErrors,
        message:
          mode === "create"
            ? `${created} products created, ${skipped} skipped`
            : `${updated} products updated, ${skipped} skipped`,
      });
    } catch (err: any) {
      res
        .status(500)
        .json({ error: "Import failed: " + (err.message || "Unknown error") });
    }
  }
);

export default router;
