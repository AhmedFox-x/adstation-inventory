export declare function initKeyManager(keysStr: string): void;
export declare function getNextKey(): string;
export declare function markExhausted(keyValue: string): void;
export declare function getStatus(): {
    index: number;
    keyPreview: string;
    exhausted: boolean;
    cooldownRemaining: number;
    requests: number;
    errors: number;
}[];
export declare function getKeyCount(): number;
//# sourceMappingURL=keyManager.d.ts.map