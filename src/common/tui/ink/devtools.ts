/**
 * Stub for the fork's dev-only devtools module (which originally imported
 * `react-devtools-core`). reconciler.ts dynamically imports this only when
 * NODE_ENV === 'development', which never happens in the bundled scripts —
 * the stub just keeps the import resolvable for the bundler.
 */
export default {};
