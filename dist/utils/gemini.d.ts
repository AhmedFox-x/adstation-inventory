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
export declare function analyzeImageWithGemini(imageBase64: string, mimeType: string): Promise<ScanResult>;
//# sourceMappingURL=gemini.d.ts.map