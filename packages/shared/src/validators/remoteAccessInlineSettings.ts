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
//   maxSessionDurationHours 0..168  (0 = no max duration, max 7 days)
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
