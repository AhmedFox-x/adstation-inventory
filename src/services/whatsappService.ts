export type WhatsAppChannel = "whatsapp_deeplink" | "whatsapp_cloud_api";

export interface WhatsAppSendResult {
  channel: WhatsAppChannel;
  success: boolean;
  recipientPhone: string;
  messageId?: string;
  deepLinkUrl?: string;
  error?: string;
}

export interface WhatsAppProvider {
  send(
    phone: string,
    message: string,
    metadata: { orderNumber: string; orderId: string }
  ): Promise<WhatsAppSendResult>;
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("20") && digits.length >= 12) return digits;
  if (digits.length === 11 && digits.startsWith("01")) return `20${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith("1")) return `20${digits}`;
  return digits;
}

function validatePhone(phone: string): boolean {
  const n = normalizePhone(phone);
  return /^20[0-9]{10,11}$/.test(n);
}

function buildDeepLink(phone: string, message: string): string {
  const normalized = normalizePhone(phone);
  const encoded = encodeURIComponent(message);
  return `https://wa.me/${normalized}?text=${encoded}`;
}

function formatPOMessage(
  orderNumber: string,
  supplierName: string,
  items: { productName: string; quantity: number; unitPrice: number }[],
  grandTotal: number,
  expectedDelivery?: string | null,
  companyName: string = "AD Station"
): string {
  const lines: string[] = [];
  lines.push(`مرحبًا فريق ${supplierName} 👋`);
  lines.push("");
  lines.push(`نرسل إليكم طلب الشراء رقم ${orderNumber}:`);
  lines.push("");
  items.forEach((item) => {
    const itemTotal = item.quantity * item.unitPrice;
    lines.push(`📦 ${item.productName}`);
    lines.push(`الكمية: ${item.quantity} قطعة`);
    if (item.unitPrice > 0) {
      lines.push(`سعر الوحدة: ${item.unitPrice.toLocaleString("ar-EG")} ج.م`);
      lines.push(`إجمالي المنتج: ${itemTotal.toLocaleString("ar-EG")} ج.م`);
    }
    lines.push("");
  });
  lines.push(`💰 الإجمالي: ${grandTotal.toLocaleString("ar-EG")} ج.م`);
  if (expectedDelivery) {
    lines.push(`📅 التسليم المتوقع: ${expectedDelivery}`);
  }
  lines.push("");
  lines.push("نرجو مراجعة الطلب وإبلاغنا بأي ملاحظات.");
  lines.push("");
  lines.push("مع الشكر والتقدير،");
  lines.push(companyName);
  return lines.join("\n");
}

const deepLinkProvider: WhatsAppProvider = {
  async send(phone, message, _metadata): Promise<WhatsAppSendResult> {
    if (!validatePhone(phone)) {
      return { channel: "whatsapp_deeplink", success: false, recipientPhone: phone, error: "رقم الهاتف غير صالح" };
    }
    const url = buildDeepLink(phone, message);
    return { channel: "whatsapp_deeplink", success: true, recipientPhone: normalizePhone(phone), deepLinkUrl: url };
  },
};

let activeProvider: WhatsAppProvider = deepLinkProvider;

export function setWhatsAppProvider(provider: WhatsAppProvider) {
  activeProvider = provider;
}

export function getWhatsAppProvider(): WhatsAppProvider {
  return activeProvider;
}

export {
  validatePhone,
  normalizePhone,
  formatPOMessage,
  buildDeepLink,
};
