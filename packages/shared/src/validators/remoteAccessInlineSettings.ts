import { z } from 'zod';

// Zod schema for the `remote_access` configuration-policy inlineSettings JSONB.
//
// The effective-config engine stores this blob untyped (JSONB), so a malformed
// value (a non-boolean clipboard flag, a zero/negative/huge session-duration)
// could otherwise flow straight to the agent. The resolver parses raw
// inlineSettings through this schema and falls back to safe defaults on failure.
//
// `.partial()` because a policy may set only a subset of fields; unset fields
// are merged over the resolver's DEFAULTS. Numeric lifetime fields are clamped
// to sane ranges via `.min()/.max()` so a hostile/buggy JSONB value can't push
// the agent into never-idle-out / never-expire territory.
//
// Ranges:
//   idleTimeoutMinutes     0..1440  (0 = idle timeout disabled, max 24h)
//   maxSessionDurationHours 0..168  (DELIBERATELY PERMISSIVE — see below)
//
// `maxSessionDurationHours` is NOT narrowed to the supported [1, 12] range here
// on purpose. This schema is all-or-nothing: a single out-of-range field fails
// the parse and the WHOLE settings blob is discarded — `remoteAccessPolicy.ts`
// falls back to DEFAULTS (re-enabling clipboard and every other gate the policy
// meant to close), `configurationPolicy.ts` throws, and the feature-link routes
// 400. Policies written before the 12 h hard cap legitimately hold `0`
// ("unlimited") or values up to 168, so tightening the bound here would be a
// security regression, not a hardening.
//
// The real [1, 12] enforcement lives in two places:
//   - read path: `clampSettings` in `apps/api/src/services/remoteAccessPolicy.ts`
//     resolves `0` or `>12` to the 12 h cap (logged once per policy);
//   - write path: the policy-editor / feature-link routes reject an
//     out-of-range value with a 400 so no NEW policy can store one.
export const remoteAccessInlineSettingsSchema = z
  .object({
    webrtcDesktop: z.boolean(),
    vncRelay: z.boolean(),
    remoteTools: z.boolean(),
    clipboardHostToViewer: z.boolean(),
    clipboardViewerToHost: z.boolean(),
    enableProxy: z.boolean(),
    defaultAllowedPorts: z.array(z.number().int().min(1).max(65535)).max(100),
    autoEnableProxy: z.boolean(),
    maxConcurrentTunnels: z.number().int().min(0).max(100),
    idleTimeoutMinutes: z.number().int().min(0).max(1440),
    maxSessionDurationHours: z.number().int().min(0).max(168),
  })
  .partial();

export type RemoteAccessInlineSettings = z.infer<typeof remoteAccessInlineSettingsSchema>;
