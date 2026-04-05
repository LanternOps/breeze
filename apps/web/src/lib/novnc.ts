// Lazy re-export for noVNC RFB class.
// Kept as an async loader so Vite's SSR analyzer never statically resolves the
// browser-only noVNC package. v1.7.0-beta ships native ESM via "exports".
export async function loadRFB() {
  // @ts-expect-error — no types for noVNC
  const mod = await import('@novnc/novnc');
  return mod.default as any;
}
