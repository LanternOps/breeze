// Task 6 (Plan 03) is a WEB-side proof: navigation, page host, and slot
// activation/disable. This fixture deliberately contributes nothing on the
// server side (no routes, no jobs, no AI tools) — `manifest.json`'s
// `server.entry` is schema-mandatory even for a web-only extension
// (packages/extension-sdk/src/manifest.ts: `server: z.object({ entry:
// safeJavaScriptPath }).strict()` has no "web-only" escape hatch), so this
// file exists purely to satisfy that requirement with a real, loadable,
// no-op module.
module.exports = {
  register() {
    // Intentionally empty: no routes, no jobs, no AI tools.
  },
};
