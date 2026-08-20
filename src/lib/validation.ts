// ── Shared Validation Library ─────────────────────────────────────────────────
// Reusable validator functions for both backend routes and shared logic.
// Each validator returns { valid: true, value } or { valid: false, error }.

export interface ValidationResult<T = any> {
  valid: boolean;
  value?: T;
  error?: string;
  errorAr?: string;
}

export interface ValidationErrors {
  field: string;
  message: string;
  messageAr: string;
}

// ── Primitive Validators ──────────────────────────────────────────────────────

export function required(value: unknown, fieldName: string): ValidationResult<string> {
  if (value === undefined || value === null || value === "") {
    return { valid: false, error: `${fieldName} is required`, errorAr: `${fieldName} مطلوب` };
  }
  const trimmed = typeof value === "string" ? value.trim() : String(value).trim();
  if (trimmed === "") {
    return { valid: false, error: `${fieldName} is required`, errorAr: `${fieldName} مطلوب` };
  }
  return { valid: true, value: trimmed };
}

export function optional(value: unknown, _fieldName: string): ValidationResult<string | null> {
  if (value === undefined || value === null || value === "") {
    return { valid: true, value: null };
  }
  const trimmed = typeof value === "string" ? value.trim() : String(value).trim();
  return { valid: true, value: trimmed || null };
}

export function isEmail(value: unknown, fieldName: string): ValidationResult<string> {
  const str = String(value || "").trim();
  if (!str) return { valid: true, value: "" }; // optional
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(str)) {
    return { valid: false, error: `${fieldName} must be a valid email address`, errorAr: `${fieldName} يجب أن يكون بريدًا إلكترونيًا صحيحًا` };
  }
  return { valid: true, value: str };
}

export function isPhone(value: unknown, fieldName: string): ValidationResult<string> {
  const str = String(value || "").trim();
  if (!str) return { valid: true, value: "" }; // optional
  const phoneRegex = /^[\d\s\-+()]{7,20}$/;
  if (!phoneRegex.test(str)) {
    return { valid: false, error: `${fieldName} must be a valid phone number`, errorAr: `${fieldName} يجب أن يكون رقم هاتف صحيحًا` };
  }
  return { valid: true, value: str };
}

export function isPositiveInt(value: unknown, fieldName: string, opts?: { min?: number; max?: number }): ValidationResult<number> {
  const num = Number(value);
  if (isNaN(num) || !Number.isInteger(num)) {
    return { valid: false, error: `${fieldName} must be a whole number`, errorAr: `${fieldName} يجب أن يكون عددًا صحيحًا` };
  }
  const min = opts?.min ?? 0;
  const max = opts?.max;
  if (num < min) {
    return { valid: false, error: `${fieldName} must be at least ${min}`, errorAr: `${fieldName} يجب أن يكون على الأقل ${min}` };
  }
  if (max !== undefined && num > max) {
    return { valid: false, error: `${fieldName} must be at most ${max}`, errorAr: `${fieldName} يجب أن يكون على الأكثر ${max}` };
  }
  return { valid: true, value: num };
}

export function isPositiveDecimal(value: unknown, fieldName: string, opts?: { min?: number; max?: number }): ValidationResult<number> {
  const num = Number(value);
  if (isNaN(num)) {
    return { valid: false, error: `${fieldName} must be a number`, errorAr: `${fieldName} يجب أن يكون رقمًا` };
  }
  const min = opts?.min ?? 0;
  const max = opts?.max;
  if (num < min) {
    return { valid: false, error: `${fieldName} must be at least ${min}`, errorAr: `${fieldName} يجب أن يكون على الأقل ${min}` };
  }
  if (max !== undefined && num > max) {
    return { valid: false, error: `${fieldName} must be at most ${max}`, errorAr: `${fieldName} يجب أن يكون على الأكثر ${max}` };
  }
  return { valid: true, value: num };
}

export function maxLength(value: unknown, fieldName: string, max: number): ValidationResult<string> {
  const str = String(value || "").trim();
  if (str.length > max) {
    return { valid: false, error: `${fieldName} must be at most ${max} characters`, errorAr: `${fieldName} يجب أن يكون على الأكثر ${max} حرفًا` };
  }
  return { valid: true, value: str };
}

export function minLength(value: unknown, fieldName: string, min: number): ValidationResult<string> {
  const str = String(value || "").trim();
  if (str.length > 0 && str.length < min) {
    return { valid: false, error: `${fieldName} must be at least ${min} characters`, errorAr: `${fieldName} يجب أن يكون على الأقل ${min} حرفًا` };
  }
  return { valid: true, value: str };
}

// ── Composite Validators ──────────────────────────────────────────────────────

export interface ValidationSchema {
  [field: string]: ((value: any) => ValidationResult)[];
}

export function validateFields(data: Record<string, any>, schema: ValidationSchema): ValidationErrors[] {
  const errors: ValidationErrors[] = [];
  for (const [field, validators] of Object.entries(schema)) {
    for (const validator of validators) {
      const result = validator(data[field]);
      if (!result.valid) {
        errors.push({ field, message: result.error!, messageAr: result.errorAr! });
        break; // first error per field
      }
    }
  }
  return errors;
}

// ── Password Strength ────────────────────────────────────────────────────────

export function isStrongPassword(value: unknown, fieldName: string): ValidationResult<string> {
  const str = String(value || "");
  if (str.length < 6) {
    return { valid: false, error: `${fieldName} must be at least 6 characters`, errorAr: `${fieldName} يجب أن يكون على الأقل 6 أحرف` };
  }
  return { valid: true, value: str };
}

// ── Common Business Validators ────────────────────────────────────────────────

export function validateStockQty(value: unknown, fieldName: string): ValidationResult<number> {
  return isPositiveInt(value, fieldName, { min: 0, max: 1000000 });
}

export function validatePrice(value: unknown, fieldName: string): ValidationResult<number> {
  return isPositiveDecimal(value, fieldName, { min: 0, max: 99999999.99 });
}

export function validateItemsArray(items: unknown, minItems = 1): ValidationResult<any[]> {
  if (!items || !Array.isArray(items) || items.length < minItems) {
    return {
      valid: false,
      error: `At least ${minItems} item(s) required`,
      errorAr: `يجب إدخال ${minItems} منتج على الأقل`,
    };
  }
  return { valid: true, value: items };
}
