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
  expectedDelivery?: string | null
): string {
  const lines: string[] = [];
  lines.push(`مرحباً ${supplierName}،`);
  lines.push(`جاري مشاركة طلب الشراء رقم: ${orderNumber}`);
  lines.push("");
  lines.push("تفاصيل الطلب:");
  items.forEach((item, idx) => {
    lines.push(
      `${idx + 1}. ${item.productName} — الكمية: ${item.quantity} × ${item.unitPrice.toLocaleString("ar-EG")} ج.م`
    );
  });
  lines.push("");
  lines.push(`الإجمالي: ${grandTotal.toLocaleString("ar-EG")} ج.م`);
  if (expectedDelivery) {
    lines.push(`التسليم المتوقع: ${expectedDelivery}`);
  }
  lines.push("");
  lines.push("لتأكيد الطلب أو الاستفسار، يرجى الرد على هذه الرسالة.");
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
