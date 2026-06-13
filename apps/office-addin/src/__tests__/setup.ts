/**
 * Vitest setup file — runs before every test file in this package.
 *
 * Provides a minimal Office.js global stub so unit tests that import
 * src/main.tsx or any module that references the Office global don't throw
 * "Office is not defined".  The real Office host is not available in jsdom;
 * tests that need richer Office behaviour should extend or override these stubs
 * inline (vi.stubGlobal / vi.spyOn).
 */

// Minimal Office.js stub -------------------------------------------------

const officeStub = {
  onReady: (cb: () => void) => Promise.resolve(cb()),
  context: {},
  HostType: {},
  PlatformType: {},
};

if (typeof globalThis.Office === 'undefined') {
  // @ts-expect-error — Office is not typed on globalThis; this is intentional
  globalThis.Office = officeStub;
}
