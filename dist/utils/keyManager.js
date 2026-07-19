"use strict";
// Key rotation manager for Gemini API
// Tracks multiple keys and rotates when quota is exhausted
Object.defineProperty(exports, "__esModule", { value: true });
exports.initKeyManager = initKeyManager;
exports.getNextKey = getNextKey;
exports.markExhausted = markExhausted;
exports.getStatus = getStatus;
exports.getKeyCount = getKeyCount;
const DEFAULT_COOLDOWN = 42000; // 42 seconds (Gemini free tier resets every ~38s)
let keys = [];
let currentIndex = 0;
let initialized = false;
function initKeyManager(keysStr) {
    const rawKeys = keysStr
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 10);
    if (rawKeys.length === 0) {
        throw new Error("No valid Gemini API keys provided in GEMINI_API_KEYS");
    }
    keys = rawKeys.map((key, i) => ({
        key,
        index: i,
        exhausted: false,
        exhaustedAt: 0,
        cooldownMs: DEFAULT_COOLDOWN,
        totalRequests: 0,
        totalErrors: 0,
    }));
    currentIndex = 0;
    initialized = true;
    console.log(`[KeyManager] Initialized with ${keys.length} key(s)`);
}
function getNextKey() {
    if (!initialized) {
        // Fallback: try single key from old env var
        const single = process.env.GEMINI_API_KEY;
        if (single)
            return single;
        throw new Error("KeyManager not initialized and no GEMINI_API_KEY set");
    }
    const now = Date.now();
    // First, try to find a non-exhausted key
    for (let i = 0; i < keys.length; i++) {
        const idx = (currentIndex + i) % keys.length;
        const k = keys[idx];
        // If key is exhausted, check if cooldown has passed
        if (k.exhausted) {
            if (now - k.exhaustedAt > k.cooldownMs) {
                // Cooldown passed, try this key again
                k.exhausted = false;
                console.log(`[KeyManager] Key #${k.index} cooldown passed, retrying`);
                currentIndex = (idx + 1) % keys.length;
                k.totalRequests++;
                return k.key;
            }
            continue; // Still in cooldown
        }
        // Key is not exhausted, use it
        currentIndex = (idx + 1) % keys.length;
        k.totalRequests++;
        return k.key;
    }
    // All keys exhausted — use the one with oldest exhaustion time
    const sorted = [...keys].sort((a, b) => a.exhaustedAt - b.exhaustedAt);
    const oldest = sorted[0];
    oldest.totalRequests++;
    console.log(`[KeyManager] All keys exhausted, using key #${oldest.index} anyway`);
    return oldest.key;
}
function markExhausted(keyValue) {
    const k = keys.find((k) => k.key === keyValue);
    if (k) {
        k.exhausted = true;
        k.exhaustedAt = Date.now();
        k.totalErrors++;
        console.log(`[KeyManager] Key #${k.index} marked exhausted (${k.totalErrors} errors total)`);
    }
}
function getStatus() {
    const now = Date.now();
    return keys.map((k) => ({
        index: k.index,
        keyPreview: k.key.slice(0, 8) + "..." + k.key.slice(-4),
        exhausted: k.exhausted,
        cooldownRemaining: k.exhausted
            ? Math.max(0, k.cooldownMs - (now - k.exhaustedAt))
            : 0,
        requests: k.totalRequests,
        errors: k.totalErrors,
    }));
}
function getKeyCount() {
    return keys.length;
}
//# sourceMappingURL=keyManager.js.map