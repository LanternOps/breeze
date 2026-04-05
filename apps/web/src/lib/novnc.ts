// Re-export noVNC RFB class.
// v1.7.0-beta ships native ESM via the "exports" field in package.json.
// @ts-expect-error — no types for noVNC
export { default as RFB } from '@novnc/novnc';
