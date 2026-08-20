import nodemailer from "nodemailer";

// ── Alert configuration from env vars ────────────────────────────────────────
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "alerts@adstation.com";
const ALERT_RECIPIENTS = (process.env.ALERT_RECIPIENT_EMAILS || "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

// ── Product info needed for alerts ───────────────────────────────────────────
interface LowStockProduct {
  id: string;
  name: string;
  stock: number;
  minStock: number;
  category: string | null;
}

// ── Check and send low-stock alerts ──────────────────────────────────────────
export async function checkAndSendAlerts(products: LowStockProduct[]): Promise<void> {
  const lowStock = products.filter((p) => p.stock <= p.minStock && p.stock >= 0);
  if (lowStock.length === 0) return;

  const transport = getTransporter();
  if (!transport) {
    console.log(`[Alert] Low stock detected but SMTP not configured. ${lowStock.length} products below minimum.`);
    return;
  }
  if (ALERT_RECIPIENTS.length === 0) {
    console.log(`[Alert] Low stock detected but ALERT_RECIPIENT_EMAILS not configured. ${lowStock.length} products.`);
    return;
  }

  const rows = lowStock
    .map(
      (p) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600">${p.name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;color:#dc2626;font-weight:700">${p.stock}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${p.minStock}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;color:#dc2626">⚠️${p.stock === 0 ? " نفد" : " تحت الحد"}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${p.category || "—"}</td>
        </tr>`
    )
    .join("");

  const html = `
  <div dir="rtl" style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;color:#111;max-width:700px;margin:0 auto">
    <div style="background:linear-gradient(135deg,#dc2626,#991b1b);color:white;padding:20px 24px;border-radius:8px 8px 0 0">
      <h1 style="margin:0;font-size:18px">⚠️ تنبيه: مخزون منخفض</h1>
      <p style="margin:4px 0 0;font-size:13px;opacity:0.9">${lowStock.length} منتج وصل أو تحت الحد الأدنى</p>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e5e7eb">
      <thead>
        <tr style="background:#f3f4f6">
          <th style="padding:8px 12px;text-align:right">المنتج</th>
          <th style="padding:8px 12px;text-align:center">المخزون</th>
          <th style="padding:8px 12px;text-align:center">الحد الأدنى</th>
          <th style="padding:8px 12px;text-align:center">الحالة</th>
          <th style="padding:8px 12px;text-align:center">التصنيف</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="padding:12px 16px;background:#fef2f2;border:1px solid #fecaca;border-top:none;border-radius:0 0 8px 8px;font-size:12px;color:#991b1b">
      يرجى مراجعة المنتجات أعلاه واتخاذ الإجراء المناسب (طلب شراء / توريد).
    </div>
    <div style="margin-top:12px;text-align:center;font-size:10px;color:#9ca3af">
      AD Station — Inventory Management System — ${new Date().toLocaleDateString("ar-EG")}
    </div>
  </div>`;

  try {
    await transport.sendMail({
      from: SMTP_FROM,
      to: ALERT_RECIPIENTS.join(","),
      subject: `⚠️ تنبيه مخزون منخفض — ${lowStock.length} منتجات (${new Date().toLocaleDateString("ar-EG")})`,
      html,
    });
    console.log(`[Alert] Low stock email sent to ${ALERT_RECIPIENTS.join(",")} for ${lowStock.length} products`);
  } catch (err: any) {
    console.error(`[Alert] Failed to send email:`, err?.message || err);
  }
}

// ── Get all currently low-stock products (for manual check / API) ────────────
export async function getLowStockProducts(prisma: any): Promise<LowStockProduct[]> {
  // Prisma can't compare two fields in a where clause, so fetch candidates and filter in JS
  const candidates = await prisma.product.findMany({
    where: { deletedAt: null, minStock: { gt: 0 } },
    select: { id: true, name: true, stock: true, minStock: true, category: true },
  });
  return candidates.filter((p: LowStockProduct) => p.stock <= p.minStock);
}

// ── Manual check endpoint helper ─────────────────────────────────────────────
export async function runManualAlertCheck(prisma: any): Promise<{ sent: boolean; count: number }> {
  const products = await prisma.product.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, stock: true, minStock: true, category: true },
  });
  const lowStock = products.filter((p: any) => p.stock <= p.minStock);
  if (lowStock.length === 0) return { sent: false, count: 0 };
  await checkAndSendAlerts(lowStock);
  return { sent: true, count: lowStock.length };
}
