import { createRequire } from 'node:module';

// Vite `resolve.alias` entry (array form) routing bare `decimal.js-light` to its
// ESM build.
//
// recharts imports `decimal.js-light` for axis tick math (getNiceTickValues,
// util/scale/util/arithmetic). That package's `"browser"` field points at
// `decimal.js`, a UMD build, and Vite prefers `browser` over `module` for
// client bundles. The UMD wrapper checks for an AMD loader *before* CommonJS:
//
//   typeof define == 'function' && define.amd ? define(...) : module.exports = Decimal
//
// Monaco's AMD loader (/monaco/vs/loader.js, see src/lib/monacoLoader.ts)
// leaves a global `define` with `define.amd` set, and <ClientRouter> keeps the
// window alive across page swaps. If the recharts chunk is first evaluated
// after a Monaco page in the same tab, Decimal registers with AMD instead of
// exporting, and every chart throws `K.default is not a constructor`.
// `decimal.mjs` is a plain ES module with no environment sniffing.
//
// decimal.js-light is a transitive dependency (via recharts), so resolve it
// from recharts' location rather than from this package.
const require = createRequire(import.meta.url);
const rechartsRequire = createRequire(require.resolve('recharts'));

// Exact-match regex: only the bare specifier is rewritten.
export const decimalJsLightAlias = {
  find: /^decimal\.js-light$/,
  replacement: rechartsRequire.resolve('decimal.js-light/decimal.mjs')
};
