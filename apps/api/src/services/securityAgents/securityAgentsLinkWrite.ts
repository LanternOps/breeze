import {
  securityAgentsEnabledVendorRequested,
  securityAgentsInlineSettingsSchema,
  type SecurityAgentsInlineSettings,
} from '@breeze/shared/validators';
import { describeFirstZodIssue } from '../../lib/zodIssues';
import { getVendor, type VendorKey } from './securityAgentVendors';

/**
 * The single write-time check for a `security_agents` feature link (#6960),
 * shared by the HTTP route, the AI `manage_policy_feature_link` tool and the
 * `addFeatureLink`/`updateFeatureLink` service backstop, so no caller can skip
 * a step.
 *
 * Order is load-bearing:
 *   1. Arming authorization. Enabling a vendor arms installs on every device the
 *      policy reaches, so it needs the same `devices.execute` grant as a
 *      software deployment. Read leniently from the raw payload and checked
 *      FIRST, so an unauthorized caller learns nothing about validation.
 *   2. `featurePolicyId` must be NULL. The generated software policy is found
 *      through `software_policies.managed_by_link_id`, never through the link.
 *   3. Strict inline-settings parse (no secrets, no unknown keys, no duplicate
 *      vendors).
 *   4. Every enabled vendor must be enableable in the registry.
 *   5. An enabled vendor may not be limited to a platform it does not support
 *      (macOS MDM-approval is allowed: those devices show as not applicable).
 *
 * The generator adds one refusal of its own inside the write transaction:
 * `security_agents_catalog_missing` when the partner has no catalog package
 * for an enabled vendor (its integration is not connected).
 *
 * The caller states whether it has authorized arming (`armAuthorized`); the
 * check never infers it.
 */

export type SecurityAgentsLinkWriteCode =
  | 'security_agents_execute_required'
  | 'security_agents_feature_policy_not_allowed'
  | 'security_agents_invalid_settings'
  | 'vendor_not_enableable'
  | 'security_agents_platform_unsupported'
  | 'security_agents_catalog_missing';

export type SecurityAgentsLinkWriteRefusal = {
  status: 400 | 403;
  body: {
    error: string;
    code: SecurityAgentsLinkWriteCode;
    vendors?: VendorKey[];
    /** Web path where the missing integration is connected (catalog_missing only). */
    setupPath?: string;
  };
};

export const SECURITY_AGENTS_EXECUTE_REQUIRED_MESSAGE =
  'Enabling a security agent installs it on the devices this policy reaches, so it requires the '
  + 'devices.execute permission — the same permission as creating a software deployment.';

export class SecurityAgentsLinkWriteError extends Error {
  readonly status: 400 | 403;
  readonly code: SecurityAgentsLinkWriteCode;
  readonly body: SecurityAgentsLinkWriteRefusal['body'];

  constructor(refusal: SecurityAgentsLinkWriteRefusal) {
    super(refusal.body.error);
    this.name = 'SecurityAgentsLinkWriteError';
    this.status = refusal.status;
    this.code = refusal.body.code;
    this.body = refusal.body;
  }
}

export type SecurityAgentsLinkWriteInput = {
  /** `undefined` = not part of this write (PATCH); `null` = explicitly cleared. */
  featurePolicyId?: string | null;
  /** `undefined` = not part of this write (PATCH). Anything else is validated, `null` included. */
  inlineSettings?: unknown;
  armAuthorized: boolean;
};

export function checkSecurityAgentsLinkWrite(
  input: SecurityAgentsLinkWriteInput,
): { ok: true; inlineSettings: SecurityAgentsInlineSettings | undefined } | { ok: false; refusal: SecurityAgentsLinkWriteRefusal } {
  if (input.inlineSettings !== undefined && securityAgentsEnabledVendorRequested(input.inlineSettings) && !input.armAuthorized) {
    return {
      ok: false,
      refusal: {
        status: 403,
        body: { error: SECURITY_AGENTS_EXECUTE_REQUIRED_MESSAGE, code: 'security_agents_execute_required' },
      },
    };
  }

  if (input.featurePolicyId !== undefined && input.featurePolicyId !== null) {
    return {
      ok: false,
      refusal: {
        status: 400,
        body: {
          error: 'A security_agents feature link carries its settings inline; featurePolicyId must not be set.',
          code: 'security_agents_feature_policy_not_allowed',
        },
      },
    };
  }

  if (input.inlineSettings === undefined) return { ok: true, inlineSettings: undefined };

  const parsed = securityAgentsInlineSettingsSchema.safeParse(input.inlineSettings);
  if (!parsed.success) {
    const described = describeFirstZodIssue(parsed.error);
    return {
      ok: false,
      refusal: {
        status: 400,
        body: {
          error: described ? `Invalid security agents settings — ${described}` : 'Invalid security agents settings.',
          code: 'security_agents_invalid_settings',
        },
      },
    };
  }

  const notEnableable = parsed.data.agents
    .filter((agent) => agent.enabled && !getVendor(agent.vendor).enableable)
    .map((agent) => agent.vendor);
  if (notEnableable.length > 0) {
    return {
      ok: false,
      refusal: {
        status: 400,
        body: {
          error: `Security agent ${notEnableable.join(', ')} cannot be enabled yet.`,
          code: 'vendor_not_enableable',
          vendors: notEnableable,
        },
      },
    };
  }

  const platformUnsupported = parsed.data.agents
    .filter((agent) => agent.enabled && (agent.platforms ?? []).some(
      (platform) => getVendor(agent.vendor).platforms[platform] === 'unsupported',
    ))
    .map((agent) => agent.vendor);
  if (platformUnsupported.length > 0) {
    return {
      ok: false,
      refusal: {
        status: 400,
        body: {
          error: `Security agent ${platformUnsupported.join(', ')} is limited to a platform it does not support.`,
          code: 'security_agents_platform_unsupported',
          vendors: platformUnsupported,
        },
      },
    };
  }

  return { ok: true, inlineSettings: parsed.data };
}

/** Throwing form for the service backstop. Returns the parsed settings to store. */
export function assertSecurityAgentsLinkWrite(input: SecurityAgentsLinkWriteInput): SecurityAgentsInlineSettings | undefined {
  const result = checkSecurityAgentsLinkWrite(input);
  if (!result.ok) throw new SecurityAgentsLinkWriteError(result.refusal);
  return result.inlineSettings;
}
