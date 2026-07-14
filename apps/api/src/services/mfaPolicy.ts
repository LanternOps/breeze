import { and, eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { roles, organizationUsers, partnerUsers } from '../db/schema/users';
import { partners } from '../db/schema/orgs';
import { getEffectiveOrgSettings } from './effectiveSettings';
import { mfaForcePartnerAdmin } from '../config/env';
import { captureException } from './sentry';

/**
 * Single source of truth for "does this user need MFA, and which factors may
 * they use". Combines role `force_mfa` (via the same membership join the
 * middleware enrollment gate used to make directly) with org/partner
 * `security.requireMfa`/`security.allowedMethods` resolved THROUGH
 * getEffectiveOrgSettings so a partner-set policy is inherited by its orgs.
 *
 * Strictest-wins: required = roleForce OR settingsRequire. A method is allowed
 * unless effective settings explicitly disable it. Passkey is always allowed —
 * it is phishing-resistant, so a tenant may restrict totp/sms but never the
 * strongest factor.
 *
 * Kill switch (MFA_FORCE_FOR_PARTNER_ADMIN=false) suppresses ONLY the
 * role-driven force (the env flag is named/documented for the partner-admin
 * role force). Org/partner settings-driven requireMfa is STILL enforced when
 * the kill switch is off — it does not collapse required to false globally.
 * `killSwitchOff` in the result therefore means "role-force suppressed".
 * allowedMethods is unaffected.
 *
 * Reads run under a system context (role join + settings touch cross-tenant
 * tables) via runOutsideDbContext+withSystemDbAccessContext so this is correct
 * whether the caller is pre-request-context (middleware/login) or inside a
 * user-scoped request context (factor completion). Settings-read errors fail
 * OPEN (not required, methods allowed) and emit bounded telemetry
 * (captureException) — a transient blip must not mass-lock a tenant nor reject
 * a factor that was allowed at enrollment. Only the SETTINGS read is fail-open;
 * the role/membership join is deliberately NOT wrapped — it shares the login
 * path's normal DB dependency, so a role-join failure is an intentional hard
 * error (failing the request is correct, not the optional-enrichment case the
 * settings fail-open covers). Do not add a try/catch around the role join.
 */
export interface MfaPolicyInput {
  scope: 'system' | 'partner' | 'organization';
  userId: string;
  orgId: string | null;
  partnerId: string | null;
}
export interface MfaAllowedMethods { totp: boolean; sms: boolean; passkey: boolean }
export interface EffectiveMfaPolicy {
  required: boolean;
  allowedMethods: MfaAllowedMethods;
  source: { roleForceMfa: boolean; settingsRequireMfa: boolean; killSwitchOff: boolean };
}

interface SecuritySettings {
  requireMfa?: boolean;
  allowedMethods?: { totp?: boolean; sms?: boolean };
}

function methodsFromSettings(security: SecuritySettings | undefined): MfaAllowedMethods {
  const am = security?.allowedMethods;
  return {
    totp: am?.totp !== false,
    sms: am?.sms !== false,
    passkey: true, // always allowed — phishing-resistant
  };
}

/**
 * @param opts.failClosed  Login/enrollment gates FAIL OPEN on a settings-read
 *   error (a transient blip must never mass-lock a tenant out of signing in).
 *   CONTROL gates that *relax* protection on a false `required` — self-disable
 *   (`/mfa/disable`) and last-factor removal (`DELETE /passkeys/:id`) — must
 *   pass `failClosed: true` so a transient read error cannot let a user strip
 *   org/partner-required MFA. On a read error under `failClosed`, `required`
 *   is forced true (the role-force axis is unaffected — its join is outside
 *   the settings try/catch and already enforces regardless).
 */
export async function getEffectiveMfaPolicy(
  input: MfaPolicyInput,
  opts?: { failClosed?: boolean },
): Promise<EffectiveMfaPolicy> {
  const killSwitchOff = !mfaForcePartnerAdmin();

  if (input.scope === 'system') {
    return {
      required: false,
      allowedMethods: { totp: true, sms: true, passkey: true },
      source: { roleForceMfa: false, settingsRequireMfa: false, killSwitchOff },
    };
  }

  return dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(async () => {
      // --- role force_mfa ---
      let roleForceMfa = false;
      if (input.scope === 'organization' && input.orgId) {
        const [row] = await dbModule.db
          .select({ forceMfa: roles.forceMfa })
          .from(organizationUsers)
          .innerJoin(roles, eq(organizationUsers.roleId, roles.id))
          .where(and(eq(organizationUsers.userId, input.userId), eq(organizationUsers.orgId, input.orgId)))
          .limit(1);
        roleForceMfa = row?.forceMfa === true;
      } else if (input.scope === 'partner' && input.partnerId) {
        const [row] = await dbModule.db
          .select({ forceMfa: roles.forceMfa })
          .from(partnerUsers)
          .innerJoin(roles, eq(partnerUsers.roleId, roles.id))
          .where(and(eq(partnerUsers.userId, input.userId), eq(partnerUsers.partnerId, input.partnerId)))
          .limit(1);
        roleForceMfa = row?.forceMfa === true;
      }

      // --- effective settings (partner-inherited for org scope) ---
      let security: SecuritySettings | undefined;
      let settingsReadFailed = false;
      try {
        if (input.scope === 'organization' && input.orgId) {
          const { effective } = await getEffectiveOrgSettings(input.orgId);
          security = effective.security as SecuritySettings | undefined;
        } else if (input.scope === 'partner' && input.partnerId) {
          const [partner] = await dbModule.db
            .select({ settings: partners.settings })
            .from(partners)
            .where(eq(partners.id, input.partnerId))
            .limit(1);
          const settings = (partner?.settings ?? {}) as Record<string, unknown>;
          security = settings.security as SecuritySettings | undefined;
        }
      } catch (err) {
        const disposition = opts?.failClosed ? 'failing closed (required)' : 'failing open (not required)';
        console.error(`[mfa-policy] effective settings read failed — ${disposition}:`, err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        security = undefined;
        settingsReadFailed = true;
      }

      const settingsRequireMfa = security?.requireMfa === true;
      // Kill switch suppresses ONLY the role-force component; settings-driven
      // requireMfa is enforced regardless (overseer hardening decision).
      const roleForceApplies = roleForceMfa && !killSwitchOff;
      // Control gates (opts.failClosed) treat an unreadable settings row as
      // "still required" so a transient blip can't strip org/partner-mandated
      // MFA; login/enrollment gates leave failClosed unset and fail open.
      const required =
        roleForceApplies || settingsRequireMfa || (settingsReadFailed && opts?.failClosed === true);

      return {
        required,
        allowedMethods: methodsFromSettings(security),
        source: { roleForceMfa, settingsRequireMfa, killSwitchOff },
      };
    }),
  );
}
