import {
  OEM_CATEGORIES,
  OEM_LANES,
  armsBeyond,
  oemUpdatesInlineSettingsSchema,
  type OemCategory,
  type OemLane,
  type OemUpdatesInlineSettings,
} from '@breeze/shared';
import { describeFirstZodIssue } from '../../lib/zodIssues';
import { isCategoryOpen } from './toolManifest';

/**
 * The single write-time check for an `oem_updates` (Vendor updates) feature
 * link (#11070, spec 4.1), shared by the HTTP routes, the AI
 * `manage_policy_feature_link` tool and the `addFeatureLink` /
 * `updateFeatureLink` service backstop, so no caller can skip a step.
 *
 * Order is load-bearing, as in `securityAgentsLinkWrite.ts`:
 *   1. Arming authorization. A write that lets a device do more than `previous`
 *      did (`armsBeyond`: switched on, a category newly true, overnight reboot
 *      switched on, a blocked ID removed) installs vendor updates, firmware or a
 *      BIOS and may reboot the machines the policy reaches, so it needs
 *      `devices.execute` + MFA. Read leniently from the raw payload and checked
 *      FIRST, so an unauthorized caller learns nothing about validation.
 *      Narrowing (switching off, removing a category, adding a blocked ID) needs
 *      only the normal link write: stopping a bad update never needs more.
 *   2. `featurePolicyId` must be NULL (Pattern B, inline settings).
 *   3. Strict inline-settings parse.
 *   4. A category whose availability gate is closed cannot be newly stored
 *      true (`oem_updates_category_gate_closed`), whatever the vendor and policy
 *      toggles say. A new `true` would start flashing the day the gate opens,
 *      which spec 4.1 forbids: opening a gate must change no stored link. A
 *      `true` already in effect (stored while the gate was open, before it was
 *      closed again) may be resent unchanged, so switching updates off or
 *      blocking an update never fails on it; the dispatch seam re-checks every
 *      gate per device anyway.
 *
 * `previous` is read strictly: a blob that no longer parses (only a direct
 * database edit can produce one) counts as null, nothing armed. The resolver
 * treats such a blob as disabled, so the gate must not credit it with anything.
 *
 * `previous` is the settings in effect for the policy before this write: its own
 * link, else the one it inherits, else null. A caller that cannot tell passes
 * null, which is the strict direction. The caller states whether it has
 * authorized arming (`armAuthorized`); the check never infers it.
 */

export type OemUpdatesLinkWriteCode =
  | 'oem_updates_execute_required'
  | 'oem_updates_feature_policy_not_allowed'
  | 'oem_updates_invalid_settings'
  | 'oem_updates_category_gate_closed';

export type OemUpdatesLinkWriteRefusal = {
  status: 400 | 403;
  body: {
    error: string;
    code: OemUpdatesLinkWriteCode;
    /** `lane:category` pairs refused by `oem_updates_category_gate_closed`. */
    categories?: string[];
  };
};

export const OEM_UPDATES_EXECUTE_REQUIRED_MESSAGE =
  'Turning on vendor updates installs vendor drivers, firmware or BIOS updates and can reboot the devices this '
  + 'policy reaches, so it requires the devices.execute permission and MFA. Turning updates off, removing a '
  + 'category or blocking an update does not.';

export class OemUpdatesLinkWriteError extends Error {
  readonly status: 400 | 403;
  readonly code: OemUpdatesLinkWriteCode;
  readonly body: OemUpdatesLinkWriteRefusal['body'];

  constructor(refusal: OemUpdatesLinkWriteRefusal) {
    super(refusal.body.error);
    this.name = 'OemUpdatesLinkWriteError';
    this.status = refusal.status;
    this.code = refusal.body.code;
    this.body = refusal.body;
  }
}

export type OemUpdatesLinkWriteInput = {
  /** `undefined` = not part of this write (PATCH); `null` = explicitly cleared. */
  featurePolicyId?: string | null;
  /** The settings in effect before the write (own link, else inherited, else null). */
  previous: unknown;
  /** `undefined` = not part of this write (PATCH). Anything else is validated, `null` included. */
  next: unknown;
  armAuthorized: boolean;
};

export type OemUpdatesGateReader = (lane: OemLane, category: OemCategory) => boolean;

/**
 * Every `lane:category` stored `true` whose gate is closed. Device-less: the lab
 * override (`BREEZE_OEM_UPDATES_LAB_DEVICE_IDS`) opens gates for a device at
 * dispatch, never for a stored policy.
 */
export function closedGateCategories(
  settings: OemUpdatesInlineSettings,
  isCategoryGateOpen: OemUpdatesGateReader = (lane, category) => isCategoryOpen(lane, category),
  previous: OemUpdatesInlineSettings | null = null,
): string[] {
  const closed: string[] = [];
  for (const lane of OEM_LANES) {
    const vendor = settings.vendors[lane];
    if (!vendor) continue;
    for (const category of OEM_CATEGORIES) {
      if (vendor.categories[category] !== true || isCategoryGateOpen(lane, category)) continue;
      // Already stored true before this write: resending it is not a new choice.
      if (previous?.vendors[lane]?.categories[category] === true) continue;
      closed.push(`${lane}:${category}`);
    }
  }
  return closed;
}

/** `previous` as the gate may trust it: strictly parsed, else null. */
function strictPrevious(previous: unknown): OemUpdatesInlineSettings | null {
  const parsed = oemUpdatesInlineSettingsSchema.safeParse(previous);
  return parsed.success ? parsed.data : null;
}

export function checkOemUpdatesLinkWrite(
  input: OemUpdatesLinkWriteInput,
  deps: { isCategoryGateOpen?: OemUpdatesGateReader } = {},
):
  | { ok: true; inlineSettings: OemUpdatesInlineSettings | undefined }
  | { ok: false; refusal: OemUpdatesLinkWriteRefusal } {
  const previous = strictPrevious(input.previous);
  if (input.next !== undefined && !input.armAuthorized && armsBeyond(previous, input.next)) {
    return {
      ok: false,
      refusal: { status: 403, body: { error: OEM_UPDATES_EXECUTE_REQUIRED_MESSAGE, code: 'oem_updates_execute_required' } },
    };
  }

  if (input.featurePolicyId !== undefined && input.featurePolicyId !== null) {
    return {
      ok: false,
      refusal: {
        status: 400,
        body: {
          error: 'A vendor updates feature link carries its settings inline; featurePolicyId must not be set.',
          code: 'oem_updates_feature_policy_not_allowed',
        },
      },
    };
  }

  if (input.next === undefined) return { ok: true, inlineSettings: undefined };

  const parsed = oemUpdatesInlineSettingsSchema.safeParse(input.next);
  if (!parsed.success) {
    const described = describeFirstZodIssue(parsed.error);
    return {
      ok: false,
      refusal: {
        status: 400,
        body: {
          error: described ? `Invalid vendor updates settings — ${described}` : 'Invalid vendor updates settings.',
          code: 'oem_updates_invalid_settings',
        },
      },
    };
  }

  const closed = closedGateCategories(parsed.data, deps.isCategoryGateOpen, previous);
  if (closed.length > 0) {
    return {
      ok: false,
      refusal: {
        status: 400,
        body: {
          error: `These update categories are not available yet and cannot be turned on: ${closed.join(', ')}.`,
          code: 'oem_updates_category_gate_closed',
          categories: closed,
        },
      },
    };
  }

  return { ok: true, inlineSettings: parsed.data };
}

/** Throwing form for the service backstop. Returns the parsed settings to store. */
export function assertOemUpdatesLinkWrite(input: OemUpdatesLinkWriteInput): OemUpdatesInlineSettings | undefined {
  const result = checkOemUpdatesLinkWrite(input);
  if (!result.ok) throw new OemUpdatesLinkWriteError(result.refusal);
  return result.inlineSettings;
}
