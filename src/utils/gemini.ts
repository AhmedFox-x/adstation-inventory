import { getNextKey, markExhausted } from "./keyManager";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { message?: string };
}

export interface ScanItem {
  name: string;
  qty: number;
  confidence: "high" | "medium" | "low";
  error?: string;
}

export interface ScanResult {
  items: ScanItem[];
  orderDate?: string;
  deliveryDate?: string;
  permitNumber?: string;
  errors: string[];
  warnings: string[];
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const SCAN_PROMPT = `Extract text from this Arabic inventory permit image. Return ONLY this JSON:

{"items":[{"name":"EXACT text as written","qty":0}],"permitNumber":"EXACT number","orderDate":"EXACT date at top","deliveryDate":"EXACT date near bottom"}

RULES:
- Extract text EXACTLY as it appears — do NOT guess, correct, or translate
- orderDate: date at the TOP of the page, read EXACTLY as written (e.g. "6/6/2024" or "9-6-2024")
- deliveryDate: date near the BOTTOM or right side, read EXACTLY as written
- permitNumber: the permit/operation number (e.g. "00804")
- items: each product row — name is the EXACT product name, qty is the number
- NO markdown, ONLY raw JSON`;

// ── Groq Provider (PRIMARY — blocked in some regions) ───────────────────────
async function tryGroq(imageBase64: string, mimeType: string): Promise<ScanResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  console.log("[Groq] Trying Groq with Llama 4 Scout Vision...");

  const body = {
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: SCAN_PROMPT },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 1024,
  };

  const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  }, 60000);

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    const errMsg = err?.error?.message || err?.message || `HTTP ${res.status}`;
    console.error(`[Groq] Error ${res.status}:`, errMsg.slice(0, 200));
    throw new Error(`Groq API ${res.status}: ${errMsg}`);
  }

  const data: any = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("Groq returned empty response");

  console.log(`[Groq] Response received (${text.length} chars)`);
  return parseAIResponse(text);
}

// ── OpenRouter Provider (Llama 4 Scout Vision) ─────────────────────────────
async function tryOpenRouter(imageBase64: string, mimeType: string): Promise<ScanResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  console.log("[OpenRouter] Trying Llama 4 Scout Vision via OpenRouter...");

  const body = {
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: SCAN_PROMPT },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 1024,
  };

  const res = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "http://localhost:4001",
      "X-Title": "AD Station Inventory",
    },
    body: JSON.stringify(body),
  }, 60000);

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    const errMsg = err?.error?.message || err?.message || `HTTP ${res.status}`;
    console.error(`[OpenRouter] Error ${res.status}:`, errMsg.slice(0, 200));
    throw new Error(`OpenRouter API ${res.status}: ${errMsg}`);
  }

  const data: any = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("OpenRouter returned empty response");

  console.log(`[OpenRouter] Response received (${text.length} chars)`);
  return parseAIResponse(text);
}

// ── Gemini Provider (FALLBACK — quota limited) ──────────────────────────────
async function tryGemini(imageBase64: string, mimeType: string): Promise<ScanResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent`;

  const body = {
    contents: [
      {
        parts: [
          { inlineData: { mimeType: mimeType || "image/jpeg", data: imageBase64 } },
          { text: SCAN_PROMPT },
        ],
      },
    ],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
  };

  const MAX_ATTEMPTS = 3;
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const apiKey = getNextKey();
    const keyPreview = apiKey.slice(0, 8) + "..." + apiKey.slice(-4);

    try {
      console.log(`[Gemini] Attempt ${attempt}/${MAX_ATTEMPTS} — key: ${keyPreview}`);

      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-goog-api-key": apiKey },
        body: JSON.stringify(body),
      }, 30000);

      if (!res.ok) {
        const err: any = await res.json().catch(() => ({}));
        const errMsg = err?.error?.message || `HTTP ${res.status}`;
        lastError = errMsg;
        console.error(`[Gemini] Key ${keyPreview} ${res.status}: ${errMsg.slice(0, 100)}`);

        if (res.status === 429 || res.status === 503) {
          markExhausted(apiKey);
          if (attempt < MAX_ATTEMPTS) { await new Promise((r) => setTimeout(r, 500)); continue; }
        }
        throw new Error(`Gemini API: ${errMsg}`);
      }

      const data: GeminiResponse = await res.json() as GeminiResponse;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!text) throw new Error("Gemini returned empty response");

      return parseAIResponse(text);
    } catch (err: any) {
      if (err.name === "AbortError") {
        lastError = "Request timed out";
        markExhausted(apiKey);
        if (attempt < MAX_ATTEMPTS) continue;
        throw new Error("Gemini API timed out");
      }
      if (err.message?.startsWith("Gemini API:")) throw err;
      lastError = err.message || "Unknown error";
      if (attempt < MAX_ATTEMPTS) { await new Promise((r) => setTimeout(r, 300)); continue; }
    }
  }

  throw new Error(`Gemini failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

// ── Shared AI Response Parser ───────────────────────────────────────────────
function parseAIResponse(text: string): ScanResult {
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);

  if (Array.isArray(parsed)) {
    return {
      items: parsed.filter((it: any) => it.name).map((it: any) => ({
        name: String(it.name).trim(),
        qty: typeof it.qty === "number" ? it.qty : 0,
        confidence: "medium" as const,
      })),
      errors: [], warnings: [],
    };
  }

  return {
    items: Array.isArray(parsed.items)
      ? parsed.items.filter((it: any) => it.name).map((it: any) => ({
          name: String(it.name).trim(),
          qty: typeof it.qty === "number" ? it.qty : 0,
          confidence: (["high", "medium", "low"].includes(it.confidence) ? it.confidence : "medium") as "high" | "medium" | "low",
          error: it.error || undefined,
        }))
      : [],
    permitNumber: parsed.permitNumber || "",
    orderDate: parsed.orderDate || "",
    deliveryDate: parsed.deliveryDate || "",
    errors: Array.isArray(parsed.errors) ? parsed.errors : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
  };
}

// ── Text Parser (smart — understands permit structure) ──────────────────────
function parsePermitText(text: string): ScanResult {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const errors: string[] = [];
  const warnings: string[] = [];
  const fullText = lines.join("\n");

  let permitNumber = "";
  let orderDate = "";
  let deliveryDate = "";

  // Extract permit number
  const permitMatch = fullText.match(/(?:No|رقم|No\.|#)\s*[:\s]*(\S+)/i);
  if (permitMatch) permitNumber = permitMatch[1].trim();

  // Extract dates — find all date-like patterns
  const dateMatches = [...fullText.matchAll(/(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/g)];
  if (dateMatches.length >= 2) {
    orderDate = dateMatches[0][1];
    deliveryDate = dateMatches[1][1];
  } else if (dateMatches.length === 1) {
    orderDate = dateMatches[0][1];
  }

  // Extract items — skip known label lines
  const items: ScanItem[] = [];
  const seenNames = new Set<string>();
  const labelPattern = /^(sir|السيد|ordered|order|date|تاريخ|رقم|no|deliv|type|operation|operation\s*permit|امر\s*التوريد|امر\s*السحب|supply|withdraw|بأمر\s*من|بامر\s*من|المرجع|tel|fax|phone|address|التاريخ|تاريخ\s*الطلب|تاريخ\s*التوريد|order\s*by)/i;

  for (const line of lines) {
    if (labelPattern.test(line)) continue;
    if (/^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}$/.test(line)) continue;
    if (line.length < 3) continue;

    const match = line.match(/^(.+?)\s+(\d+)\s*$/);
    if (match) {
      const name = match[1].trim();
      const qty = parseInt(match[2], 10);
      if (name.length > 1 && qty > 0 && !seenNames.has(name.toLowerCase())) {
        seenNames.add(name.toLowerCase());
        items.push({ name, qty, confidence: "high" });
      }
    }
  }

  if (items.length === 0) warnings.push("لم يتم التعرف على أي منتجات — راجع النص اليدوي");

  return { items, orderDate, deliveryDate, permitNumber, errors, warnings };
}

// ── OCR.space Provider (LAST RESORT — external) ─────────────────────────────
async function tryOCRSpace(imageBase64: string, mimeType: string): Promise<ScanResult | null> {
  const apiKey = process.env.OCRSPACE_API_KEY;
  if (!apiKey) return null;

  console.log("[OCR.space] Trying OCR.space...");

  const body = new URLSearchParams();
  body.append("base64Image", `data:${mimeType};base64,${imageBase64}`);
  body.append("language", "ara");
  body.append("isOverlayRequired", "false");
  body.append("OCREngine", "2");
  body.append("scale", "true");
  body.append("isTable", "true");

  try {
    const res = await fetchWithTimeout("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: {
        apikey: apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    }, 30000);

    if (!res.ok) {
      console.error(`[OCR.space] HTTP ${res.status}`);
      return null;
    }

    const data: any = await res.json();

    if (data.IsErroredOnProcessing || !data.ParsedResults?.length) {
      console.error("[OCR.space] Parse error:", data.ErrorMessage?.join(", "));
      return null;
    }

    const rawText = data.ParsedResults.map((r: any) => r.ParsedText || "").join("\n");
    console.log(`[OCR.space] Extracted ${rawText.length} chars`);

    return parsePermitText(rawText);
  } catch (err: any) {
    console.error("[OCR.space] Error:", err.message);
    return null;
  }
}

// ── Tesseract OCR Provider (LOCAL — no API key, no internet) ────────────────
async function tryTesseract(imageBase64: string, mimeType: string): Promise<ScanResult | null> {
  console.log("[Tesseract] Trying local Tesseract OCR...");

  const tmpFile = join(process.env.TEMP || "/tmp", `scan_${Date.now()}.png`);
  const outFile = tmpFile.replace(".png", "");

  try {
    const buffer = Buffer.from(imageBase64, "base64");
    writeFileSync(tmpFile, buffer);

    // Try eng first (better accuracy for printed text), then ara+eng
    const tries = [
      `tesseract "${tmpFile}" "${outFile}" -l eng --psm 6 --oem 3`,
      `tesseract "${tmpFile}" "${outFile}_ara" -l ara+eng --psm 6 --oem 3`,
    ];

    let rawText = "";

    for (const cmd of tries) {
      try {
        execSync(cmd, { timeout: 30000, stdio: "pipe" });
        const outFileTxt = cmd.includes("_ara") ? `${outFile}_ara.txt` : `${outFile}.txt`;
        const text = readFileSync(outFileTxt, "utf-8");
        if (text.trim().length > rawText.length) rawText = text;
      } catch {}
    }

    if (!rawText.trim()) {
      // Fallback: single pass
      try {
        execSync(`tesseract "${tmpFile}" "${outFile}" -l eng --psm 4 --oem 3`, { timeout: 30000, stdio: "pipe" });
        rawText = readFileSync(`${outFile}.txt`, "utf-8");
      } catch {}
    }

    console.log(`[Tesseract] Extracted ${rawText.length} chars`);

    if (!rawText.trim()) {
      console.log("[Tesseract] Empty result");
      return null;
    }

    console.log(`[Tesseract] Raw text:\n${rawText}`);
    return parsePermitText(rawText);
  } catch (err: any) {
    console.error("[Tesseract] Error:", err.message?.slice(0, 100));
    return null;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
    try { unlinkSync(`${outFile}.txt`); } catch {}
    try { unlinkSync(`${outFile}_ara.txt`); } catch {}
  }
}

// ── Main: Groq → OpenRouter → Gemini → Tesseract → OCR.space ────────────────
export async function analyzeImageWithGemini(
  imageBase64: string,
  mimeType: string
): Promise<ScanResult> {
  // 1. Try Groq first (14,400 req/day free, Llama 4 Scout Vision)
  try {
    const groqResult = await tryGroq(imageBase64, mimeType);
    console.log(`[Scan] Groq succeeded: ${groqResult.items.length} items`);
    return groqResult;
  } catch (err: any) {
    console.log("[Scan] Groq failed:", err.message?.slice(0, 150));
  }

  // 2. Try OpenRouter (Llama 4 Scout Vision via OpenRouter)
  try {
    const orResult = await tryOpenRouter(imageBase64, mimeType);
    console.log(`[Scan] OpenRouter succeeded: ${orResult.items.length} items`);
    return orResult;
  } catch (err: any) {
    console.log("[Scan] OpenRouter failed:", err.message?.slice(0, 150));
  }

  // 3. Try Gemini third (quota limited)
  try {
    const geminiResult = await tryGemini(imageBase64, mimeType);
    console.log(`[Scan] Gemini succeeded: ${geminiResult.items.length} items`);
    return geminiResult;
  } catch (err: any) {
    console.log("[Scan] Gemini failed:", err.message?.slice(0, 150));
  }

  // 4. Try Tesseract (LOCAL — always available, no API key)
  const tessResult = await tryTesseract(imageBase64, mimeType);
  if (tessResult) {
    console.log(`[Scan] Tesseract returned: ${tessResult.items.length} items`);
    tessResult.warnings.push("تم القراءة بـ OCR محلي — راجع النتائج يدوياً");
    return tessResult;
  }

  // 5. Fallback to OCR.space (external, needs API key)
  console.log("[Scan] Falling back to OCR.space...");
  const ocrResult = await tryOCRSpace(imageBase64, mimeType);
  if (ocrResult) {
    console.log(`[Scan] OCR.space returned: ${ocrResult.items.length} items`);
    ocrResult.warnings.push("تم القراءة بـ OCR عادي — راجع النتائج يدوياً");
    return ocrResult;
  }

  throw new Error("All providers failed. Check your setup.");
}
