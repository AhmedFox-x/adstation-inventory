interface ProductLike {
    id: string;
    name: string;
    variant?: string | null;
}
export declare function bestMatch(name: string, products: ProductLike[]): {
    product: ProductLike | null;
    score: number;
};
export {};
//# sourceMappingURL=fuzzy.d.ts.map