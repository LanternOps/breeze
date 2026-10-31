import { z } from 'zod';
import {
  AGENT_REPORTABLE_STATES,
  ISOLATION_JOURNAL_PHASES,
  ISOLATION_MECHANISMS,
  NETWORK_ISOLATION_LIMITS,
  NETWORK_ISOLATION_TTL,
} from '../utils/networkIsolation';

/**
 * Network-isolation containment wire contracts (#10088, plan "Cross-wave interfaces"). The agent's Go
 * types (agent/internal/isolation/types.go, W1d) carry JSON tags matching these shapes exactly.
 */

const portSchema = z.number().int().min(1).max(65535);
const portsSchema = z
  .array(portSchema)
  .min(1)
  .max(16)
  .refine((ports) => new Set(ports).size === ports.length, { message: 'ports must be unique' });

const protoSchema = z.enum(['tcp', 'udp', 'udp+tcp']);

/** `breeze` = Breeze processes only where the OS can match a process; `any` = any process (policy extras only). */
const scopeSchema = z.enum(['breeze', 'any']);

// RFC 1123 host name: dot-separated labels of 1-63 letters, digits or hyphens, no leading/trailing hyphen.
const HOST_NAME_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(?:\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;

const hostNameSchema = z
  .string()
  .regex(HOST_NAME_RE, 'host must be a DNS name')
  // An address belongs in a `cidr` entry: the agent resolves `host` entries, a literal needs no resolving.
  // An all-digit last label (`127.1`, `3232235777`) is read as an address by many resolvers (RFC 3696 §2).
  .refine((host) => !/(?:^|\.)\d+$/.test(host), { message: 'an IP address is a cidr entry, not a host' });

const cidrSchema = z
  .union([z.cidrv4(), z.cidrv6()])
  // Isolation never carries a blanket permit (spec §3.4).
  .refine((cidr) => !cidr.endsWith('/0'), { message: 'a /0 permit is not allowed' });

export const isolationAllowEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host'), host: hostNameSchema, proto: protoSchema, ports: portsSchema, scope: scopeSchema }),
  z.strictObject({ kind: z.literal('cidr'), cidr: cidrSchema, proto: protoSchema, ports: portsSchema, scope: scopeSchema }),
]);
export type IsolationAllowEntry = z.infer<typeof isolationAllowEntrySchema>;

const ttlHoursSchema = z.number().int().min(1).max(NETWORK_ISOLATION_TTL.maxHours);
const reasonSchema = z.string().trim().min(1).max(2000);

/** POST /devices/:id/network-isolation. The caller never supplies the allowlist. */
export const startNetworkIsolationSchema = z
  .strictObject({
    incidentId: z.uuid().optional(),
    createIncident: z
      .strictObject({
        severity: z.enum(['p1', 'p2', 'p3', 'p4']),
        title: z.string().trim().min(1).max(200),
      })
      .optional(),
    ttlHours: ttlHoursSchema.optional(),
    reason: reasonSchema,
    remoteRelay: z.boolean().optional(),
  })
  .refine((v) => (v.incidentId === undefined) !== (v.createIncident === undefined), {
    message: 'exactly one of incidentId and createIncident is required',
    path: ['incidentId'],
  });
export type StartNetworkIsolationInput = z.infer<typeof startNetworkIsolationSchema>;

export const releaseNetworkIsolationSchema = z.strictObject({ reason: reasonSchema });
export type ReleaseNetworkIsolationInput = z.infer<typeof releaseNetworkIsolationSchema>;

export const extendNetworkIsolationSchema = z.strictObject({ ttlHours: ttlHoursSchema });
export type ExtendNetworkIsolationInput = z.infer<typeof extendNetworkIsolationSchema>;

const timestampSchema = z.string().datetime({ offset: true });

/** A string cut to `max` characters (code points) instead of failing validation. */
function truncated(max: number) {
  return z.string().transform((s) => Array.from(s).slice(0, max).join(''));
}

/**
 * Base64 (standard alphabet, padded) of exactly 32 bytes: 43 characters plus one `=`. Checked by
 * shape so the schema needs no Buffer (it also runs in the browser).
 */
const breakGlassSecretSchema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'breakGlassSecret must be base64 of 32 bytes');

const desiredBase = {
  isolationId: z.uuid(),
  generation: z.number().int().min(1),
  expiresAt: timestampSchema,
  deadManSeconds: z.number().int().min(0),
  remoteRelay: z.boolean(),
};

/**
 * The heartbeat response's desired state for one device.
 * - `isolated`: the permits to install (never empty: the control plane is always one). `breakGlassSecret`
 *   travels only until the agent acknowledges it (`break_glass_ack_seq`), only over the agent's TLS
 *   channel, and is never logged or audited (Gate B decision 4 vii).
 * - `released`: the tombstone. No permits and never the secret (strict: the key is rejected).
 */
export const networkIsolationDesiredSchema = z.discriminatedUnion('desired', [
  z.strictObject({
    ...desiredBase,
    desired: z.literal('isolated'),
    allow: z.array(isolationAllowEntrySchema).min(1).max(NETWORK_ISOLATION_LIMITS.maxAllowEntries),
    breakGlassSecret: breakGlassSecretSchema.optional(),
  }),
  z.strictObject({
    ...desiredBase,
    desired: z.literal('released'),
    allow: z.array(isolationAllowEntrySchema).max(0),
  }),
]);
export type NetworkIsolationDesired = z.infer<typeof networkIsolationDesiredSchema>;

/**
 * The heartbeat response's `containment` block. ALWAYS sent: `networkIsolation: null` means the server
 * asserts nothing; an absent key is invalid (absent-means-no-change is the one-way-switch trap the
 * `ech_enabled` comment in heartbeat.ts documents). A release travels as `desired: 'released'` until the
 * agent confirms, never as a bare null.
 */
export const containmentDesiredBlockSchema = z.strictObject({
  networkIsolation: networkIsolationDesiredSchema.nullable(),
});
export type ContainmentDesiredBlock = z.infer<typeof containmentDesiredBlockSchema>;

/** One entry of the agent's append-only isolation journal, reported so the server can record it. */
export const isolationJournalEventSchema = z.object({
  seq: z.number().int().min(0),
  at: timestampSchema,
  type: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  isolationId: z.uuid().optional(),
  generation: z.number().int().min(1).optional(),
  /** Diagnostic text: truncated, never a reason to drop the report. */
  detail: truncated(500).optional(),
});
export type IsolationJournalEvent = z.infer<typeof isolationJournalEventSchema>;

const reportExtras = {
  secretAckSeq: z.number().int().min(0).optional(),
  recoveryVersion: z.string().max(64).optional(),
  events: z.array(isolationJournalEventSchema).max(NETWORK_ISOLATION_LIMITS.maxReportEvents).optional(),
};

/**
 * What the agent reports for an episode. Unknown keys are stripped rather than rejected so a newer
 * agent's report still reconciles; nullable fields also accept absence (Go `omitempty`); free-text
 * diagnostics are truncated rather than rejected. The closed sets (state, phase, mechanism) stay strict:
 * the server ships before any agent that could send a new member, and the caller (W1b reconcile) logs
 * a report it cannot parse.
 */
const activeReportSchema = z.object({
  isolationId: z.uuid(),
  generation: z.number().int().min(1),
  journalSeq: z.number().int().min(0),
  state: z.enum(AGENT_REPORTABLE_STATES),
  phase: z.enum(ISOLATION_JOURNAL_PHASES),
  mechanism: z.enum(ISOLATION_MECHANISMS).nullish(),
  appliedAt: timestampSchema.nullish(),
  lastVerifiedAt: timestampSchema.nullish(),
  ruleDigest: z.string().max(128).nullish(),
  lastError: truncated(1000).nullish(),
  ...reportExtras,
});

/** "Nothing Breeze-owned is installed": how the agent confirms a release tombstone. */
const absentReportSchema = z.object({
  isolationId: z.null().optional(),
  phase: z.literal('none'),
  journalSeq: z.number().int().min(0).optional(),
  ...reportExtras,
});

export const networkIsolationReportSchema = z.union([activeReportSchema, absentReportSchema]);
export type NetworkIsolationReport = z.infer<typeof networkIsolationReportSchema>;
