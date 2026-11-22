import { z } from 'zod';

// Wake readiness snapshot the agent uploads (PUT /agents/:agentId/wake-status).
// Agent-reportable states only; the server adds unsupported_os,
// agent_update_required, no_data and lookup_failed. Keep this list identical to
// WAKE_READINESS_STATES in apps/api/src/db/schema/deviceWake.ts (an API test
// asserts equality).
export const WAKE_AGENT_READINESS_STATES = [
  'ready',
  'needs_reboot',
  'not_configured',
  'apply_failed',
  'firmware_protected',
  'unproven',
  'no_wired_adapter',
  'unsupported_vm',
] as const;
export type WakeAgentReadinessState = (typeof WAKE_AGENT_READINESS_STATES)[number];

const isoDateTime = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// details.vendorObservation (#10838 observe-first amendment §2)
//
// What the agent read from a granted vendor's firmware interface (HP, Lenovo)
// or, for Surface, the readiness classifier's inputs. It is untrusted device
// output, so every object is strict, every key is required (nullable, never
// optional), every string is bounded and free of control and format
// characters, and the whole block is capped in UTF-8 bytes (zod's `.max()`
// counts code points). No field can hold a serial, UUID, asset or ownership
// tag, host or user name, or MAC address. The agent mirrors these shapes in
// agent/internal/biosconfig; both sides test the goldens in that package's
// testdata/wire.
// ---------------------------------------------------------------------------

export const WAKE_VENDOR_OBSERVATION_MAX_BYTES = 16 * 1024;
export const WAKE_OBSERVED_SETTINGS_MAX_BYTES = 8 * 1024;
export const WAKE_OBSERVATION_INTERFACES = ['present', 'absent', 'access_denied', 'error'] as const;
export const WAKE_OBSERVATION_VENDORS = ['hp', 'lenovo', 'microsoft'] as const;

const NO_CONTROL_OR_FORMAT = /^[^\p{Cc}\p{Cf}]*$/u;
const deviceText = (max: number) =>
  z.string().min(1).max(max).regex(NO_CONTROL_OR_FORMAT, 'must not contain control or format characters');
const looseDeviceText = (max: number) =>
  z.string().max(max).regex(NO_CONTROL_OR_FORMAT, 'must not contain control or format characters');
const identifier = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_.:-]+$/, 'must be an identifier');
const count = z.number().int().min(0).max(100_000);
const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const observedSettingSchema = z
  .object({
    name: deviceText(64),
    value: looseDeviceText(64),
    possibleValues: z.array(deviceText(64)).max(16),
  })
  .strict();

const observedSettingsSchema = z
  .array(observedSettingSchema)
  .max(48)
  .superRefine((settings, ctx) => {
    if (utf8Bytes(settings) > WAKE_OBSERVED_SETTINGS_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', message: `settings exceed ${WAKE_OBSERVED_SETTINGS_MAX_BYTES} bytes` });
    }
  });

const hpObservationSchema = z
  .object({
    settings: observedSettingsSchema,
    settingCount: count,
    truncated: z.boolean(),
    setupPasswordSet: z.boolean().nullable(),
    powerOnPasswordSet: z.boolean().nullable(),
    sureAdmin: deviceText(64).nullable(),
    settingInterface: z.boolean().nullable(),
  })
  .strict();

const lenovoObservationSchema = z
  .object({
    settings: observedSettingsSchema,
    settingCount: count,
    truncated: z.boolean(),
    passwordState: z.number().int().min(0).max(65_535).nullable(),
    classes: z.array(z.string().regex(/^Lenovo_[A-Za-z0-9_]{1,57}$/)).max(64),
    machineType: z.string().regex(/^[0-9][A-Z0-9]{3}$/).nullable(),
    selectionCalls: z.number().int().min(0).max(48),
    selectionErrors: z.number().int().min(0).max(48),
  })
  .strict();

const surfaceAdapterSchema = z
  .object({
    pnpId: z.string().regex(/^(PCI\\VEN_[0-9A-F]{4}&DEV_[0-9A-F]{4}|USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4})$/).nullable(),
    driverProvider: deviceText(64).nullable(),
    description: deviceText(64).nullable(),
    surfaceMatch: z.boolean(),
  })
  .strict();

const surfaceObservationSchema = z
  .object({
    systemSku: deviceText(64).nullable(),
    model: deviceText(64).nullable(),
    virtual: z.boolean(),
    virtualPlatform: identifier(32).nullable(),
    decidedBy: z.enum(['vm_rule', 'surface_model', 'other_model', 'error']),
    adapters: z.array(surfaceAdapterSchema).max(16),
    adaptersTruncated: z.boolean(),
  })
  .strict();

const observationCommon = {
  schema: z.literal(1),
  nativeArch: z.enum(['amd64', 'arm64', 'x86', 'unknown']),
  interface: z.enum(WAKE_OBSERVATION_INTERFACES),
  errorCode: identifier(64).nullable(),
  durationMs: z.number().int().min(0).max(3_600_000),
  collectedWith: deviceText(32),
};

export const wakeVendorObservationSchema = z
  .discriminatedUnion('vendor', [
    z.object({ ...observationCommon, vendor: z.literal('hp'), hp: hpObservationSchema }).strict(),
    z.object({ ...observationCommon, vendor: z.literal('lenovo'), lenovo: lenovoObservationSchema }).strict(),
    z.object({ ...observationCommon, vendor: z.literal('microsoft'), surface: surfaceObservationSchema }).strict(),
  ])
  .superRefine((observation, ctx) => {
    if (utf8Bytes(observation) > WAKE_VENDOR_OBSERVATION_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', message: `vendorObservation exceeds ${WAKE_VENDOR_OBSERVATION_MAX_BYTES} bytes` });
    }
  });
export type WakeVendorObservation = z.infer<typeof wakeVendorObservationSchema>;

// details stays open (the agent's readiness fields are not part of the
// contract yet), except vendorObservation, which is typed and bounded.
const wakeStatusDetailsSchema = z
  .object({ vendorObservation: wakeVendorObservationSchema.optional() })
  .catchall(z.unknown()); // otherwise bounded by the route's 64 KiB body limit

export const wakeStatusSnapshotSchema = z.object({
  readinessState: z.enum(WAKE_AGENT_READINESS_STATES),
  reasonCodes: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(16),
  vendor: z.string().min(1).max(32).nullable(),
  fingerprint: z.string().min(1).max(128),
  collectedAt: isoDateTime,
  lastApplyAt: isoDateTime.nullable(),
  lastApplyResult: z.string().max(32).nullable(),
  lastWiredAdapterSeenAt: isoDateTime.nullable(),
  details: wakeStatusDetailsSchema,
}).strict();

export type WakeStatusSnapshot = z.infer<typeof wakeStatusSnapshotSchema>;
