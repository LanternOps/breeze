import { z } from 'zod';
import { OEM_OBSERVE_LANES } from '../utils/oemUpdates';

/**
 * `oem_observe` wire contracts (observe-first amendment, #11065 §2).
 *
 * Observe is the read-only step a best-guess vendor lane takes before it may
 * write: the agent reports what is on the machine and touches nothing. The
 * result is untrusted device output, so:
 *
 * - every object is strict, and every key is required (nullable, never
 *   optional), so a golden carries every key the schema has;
 * - every string is bounded and refuses control characters;
 * - names of tools and conflicting apps are a closed list, never free text;
 * - no field can hold a serial, a UUID, a path, a MAC, a hostname, a user name
 *   or key material: a path is reduced to a location class on the agent;
 * - the whole result is at most {@link OEM_OBSERVE_RESULT_MAX_BYTES}.
 *
 * The agent mirrors these shapes in agent/internal/oemupdates/observe; both
 * sides test against the goldens in that package's testdata/wire.
 */

const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/;
const toolText = (max: number) => z.string().max(max).regex(NO_CONTROL_CHARS, 'must not contain control characters');
const identifier = (max: number) =>
  z.string().min(1).max(max).regex(/^[A-Za-z0-9_.:-]+$/, 'must be an identifier');
const count = z.number().int().min(0).max(100_000);
const httpStatus = z.number().int().min(100).max(599);

export const OEM_OBSERVE_RESULT_MAX_BYTES = 32 * 1024;

const observeLaneSchema = z.enum(OEM_OBSERVE_LANES);

export const oemObservePayloadSchema = z
  .object({
    lane: observeLaneSchema,
    // 'scan' (fetch the vendor tool and run its read-only analysis) is D-OEM-2,
    // which the owner declined for now: it is not in the contract at all.
    observeLevel: z.literal('passive'),
    // Ids only, as oem_update_run sends them. The agent answers with a boolean.
    escrowedProtectorIds: z.array(z.string().uuid()).max(16),
  })
  .strict();
export type OemObservePayload = z.infer<typeof oemObservePayloadSchema>;

/** Vendor tooling Breeze could drive. Presence and version only. */
export const OEM_OBSERVE_TOOLS = [
  'hpia',
  'hp_cmsl',
  'lenovo_system_update',
  'lenovo_thin_installer',
  'lenovo_lsuclient',
  'lenovo_client_update',
] as const;

/** Resident vendor apps that could fight a Breeze run (plan D3, L0). */
export const OEM_OBSERVE_CONFLICTS = [
  'hp_support_assistant',
  'lenovo_vantage',
  'lenovo_commercial_vantage',
  'lenovo_system_update',
  'dell_supportassist',
] as const;

const toolSchema = z
  .object({
    name: z.enum(OEM_OBSERVE_TOOLS),
    version: toolText(64).nullable(),
    publisher: toolText(128).nullable(),
    /** Null when the signature was not checked. */
    signatureValid: z.boolean().nullable(),
    location: z.enum(['program_files', 'agent_dir', 'windows_apps', 'other']),
  })
  .strict();

const conflictSchema = z
  .object({
    name: z.enum(OEM_OBSERVE_CONFLICTS),
    version: toolText(64).nullable(),
  })
  .strict();

const errorSchema = z.object({ step: identifier(32), code: identifier(64) }).strict();

const commonShape = {
  schema: z.literal(1),
  agentVersion: toolText(32).min(1),
  /** From IsWow64Process2's native machine: the amd64 agent runs emulated on ARM64. */
  nativeArch: z.enum(['amd64', 'arm64', 'x86', 'unknown']),
  osBuild: toolText(32).nullable(),
  smbios: z
    .object({
      manufacturer: toolText(64).nullable(),
      model: toolText(64).nullable(),
      systemSku: toolText(64).nullable(),
      family: toolText(64).nullable(),
      /** HP's platform ID lives here, which HPIA's platform support is keyed on. */
      baseboardProduct: toolText(32).nullable(),
    })
    .strict(),
  bios: z
    .object({
      version: toolText(64).nullable(),
      releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    })
    .strict(),
  chassis: z.enum(['desktop', 'laptop', 'tablet', 'convertible', 'detachable', 'all_in_one', 'other', 'unknown']),
  power: z
    .object({
      acLine: z.enum(['on', 'off', 'unknown']),
      // Raw SYSTEM_POWER_STATUS bytes, so 128 (no battery) and 255 (unknown) are seen as they are.
      batteryFlag: z.number().int().min(0).max(255).nullable(),
      batteryPercent: z.number().int().min(0).max(255).nullable(),
    })
    .strict(),
  bitlocker: z
    .object({
      protection: z.enum(['on', 'off', 'suspended', 'unknown']),
      pcr7Bound: z.boolean().nullable(),
      activeProtectorEscrowed: z.boolean().nullable(),
    })
    .strict(),
  pendingReboot: z.boolean().nullable(),
  tools: z.array(toolSchema).max(12),
  conflicts: z.array(conflictSchema).max(8),
  errors: z.array(errorSchema).max(16),
  /** Set when any list was cut to its bound. */
  truncated: z.boolean(),
};

const surfaceUpdateSchema = z
  .object({
    title: toolText(200),
    updateId: toolText(64),
    driverManufacturer: toolText(128).nullable(),
    driverClass: toolText(64).nullable(),
    driverModel: toolText(200).nullable(),
    driverProvider: toolText(128).nullable(),
    /** What the shipped Surface filter would do with it, computed with no side effects. */
    laneWouldSelect: z.enum(['driver', 'firmware', 'none']),
  })
  .strict();

const surfaceResultSchema = z
  .object({
    ...commonShape,
    lane: z.literal('surface'),
    surface: z
      .object({
        windowsUpdate: z.enum(['ok', 'failed', 'service_disabled']),
        excludeWUDriversInQualityUpdate: z
          .object({ state: z.enum(['absent', 'present', 'unreadable']), value: z.number().int().nullable() })
          .strict(),
        updates: z.array(surfaceUpdateSchema).max(50),
      })
      .strict(),
  })
  .strict();

const hpResultSchema = z
  .object({
    ...commonShape,
    lane: z.literal('hp'),
    hp: z
      .object({
        /** Whether `root\HP\InstrumentedBIOS` exists. A namespace check, no setting is read. */
        instrumentedBiosNamespace: z.boolean().nullable(),
        /** One HEAD to HP's HPIA reference catalog. Null when not probed. Status is null on a network error. */
        platformCatalog: z.object({ status: httpStatus.nullable() }).strict().nullable(),
      })
      .strict(),
  })
  .strict();

const lenovoResultSchema = z
  .object({
    ...commonShape,
    lane: z.literal('lenovo'),
    lenovo: z
      .object({
        /** The MTM: the first four characters of the model. Validated before any URL is built from it. */
        machineType: z.string().regex(/^[A-Z0-9]{4}$/).nullable(),
        family: z.enum(['thinkpad', 'thinkcentre', 'thinkstation', 'ideapad', 'other', 'unknown']),
        /**
         * One GET of download.lenovo.com/catalog/<MTM>_Win<10|11>.xml. That catalog
         * lists each package's location, category and checksum only: PackageType
         * and RebootType live in each package's own descriptor XML, which passive
         * observe does not fetch. So the counts here are by Lenovo's category text
         * (vendor catalog data, not device data).
         */
        catalog: z
          .object({
            status: httpStatus.nullable(),
            windows: z.enum(['10', '11']).nullable(),
            packageCount: count,
            categories: z.array(z.object({ name: toolText(96).min(1), count }).strict()).max(32),
            /** A category naming BIOS is listed. */
            biosListed: z.boolean(),
            /** The catalog was larger than the read bound; the counts cover what was read. */
            truncated: z.boolean(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();

export const oemObserveResultSchema = z
  .discriminatedUnion('lane', [surfaceResultSchema, hpResultSchema, lenovoResultSchema])
  .superRefine((value, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(value)).length > OEM_OBSERVE_RESULT_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', message: `observation exceeds ${OEM_OBSERVE_RESULT_MAX_BYTES} bytes` });
    }
  });
export type OemObserveResult = z.infer<typeof oemObserveResultSchema>;
