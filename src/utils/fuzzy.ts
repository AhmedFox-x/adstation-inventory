function normalizeAr(s: string): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[\u064B-\u0652]/g, "")
    .replace(/\s+/g, " ");
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;

  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return d[m][n];
}

function similarity(a: string, b: string): number {
  const na = normalizeAr(a);
  const nb = normalizeAr(b);
  if (!na || !nb) return 0;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

interface ProductLike {
  id: string;
  name: string;
  variant?: string | null;
}

export function bestMatch(
  name: string,
  products: ProductLike[]
): { product: ProductLike | null; score: number } {
  let best: ProductLike | null = null;
  let bestScore = 0;

  for (const p of products) {
    const s = Math.max(
      similarity(name, p.name),
      p.variant ? similarity(name, p.name + " " + p.variant) : 0
    );
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }

  return { product: best, score: bestScore };
}
