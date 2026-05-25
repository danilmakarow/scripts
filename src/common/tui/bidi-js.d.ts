/**
 * Ambient types for `bidi-js` (the package ships none). This file is a script
 * (no imports/exports), so `declare module` creates the module's types rather
 * than augmenting — which is what an untyped package needs. The engine only
 * calls `getEmbeddingLevels`; the rest mirror the package's real surface.
 */
declare module 'bidi-js' {
  interface BidiInstance {
    getEmbeddingLevels(
      text: string,
      direction?: 'ltr' | 'rtl' | 'auto',
    ): { levels: Uint8Array; paragraphs: unknown };
    getReorderSegments(
      text: string,
      embeddingLevels: { levels: Uint8Array },
      start?: number,
      end?: number,
    ): Array<[number, number]>;
  }
  const bidiFactory: () => BidiInstance;
  export default bidiFactory;
}
