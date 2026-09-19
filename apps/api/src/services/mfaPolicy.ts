import { and, eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { roles, organizationUsers, partnerUsers } from '../db/schema/users';
import { partners } from '../db/schema/orgs';
import { getEffectiveOrgSettings } from './effectiveSettings';
import { mfaForcePartnerAdmin } from '../config/env';
import {
  evaluateMfaEnrollmentGrace,
  resolveMfaGraceDays,
  type MfaGraceFacts,
} from './mfaEnrollmentGrace';
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
 * Enrolment grace window (#5306): a role-forced account that has NEVER held a
 * factor gets a per-user, nonrenewable deadline (services/mfaEnrollmentGrace.ts)
 * before the role force is enforced. While that window is open the ROLE axis is
 * postponed (`required` false, `pendingEnrollment.deadline` set); once it lapses
 * `required` is true exactly as it was before the feature. The window is only
 * consulted when the role force would otherwise bite and settings do not already
 * require MFA — so strictest-wins and the kill-switch semantics below are
 * untouched, and an already-enrolled user stays `required` (which is what keeps
 * self-disable and last-passkey removal blocked mid-window).
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
  /**
   * #5306 — set while this user's enrolment grace window is OPEN. It describes
   * the window, not the verdict: a settings-read failure under `failClosed` can
   * legitimately report `required: true` alongside an open window. UI copy
   * ("enrol by <date>") should read this; gates must read `required`.
   */
  pendingEnrollment: { deadline: string } | null;
  source: {
    roleForceMfa: boolean;
    settingsRequireMfa: boolean;
    killSwitchOff: boolean;
    /** 'active' | 'expired' while a grant exists for a role-forced user, else 'none'. */
    graceWindow: 'active' | 'expired' | 'none';
  };
}

export interface MfaSecuritySettings {
  requireMfa?: boolean;
  allowedMethods?: { totp?: boolean; sms?: boolean };
  /** #5306 — partner-configurable enrolment grace length in days (0..30, default 14). */
  mfaEnrollmentGraceDays?: number;
}
type SecuritySettings = MfaSecuritySettings;

function methodsFromSettings(
  security: SecuritySettings | undefined,
  settingsUnavailable = false,
  failClosedMethods = false,
): MfaAllowedMethods {
  if (settingsUnavailable && failClosedMethods) {
    // TOTP and SMS are tenant-configurable, so an unreadable policy cannot
    // authorize either at a sensitive control boundary. Passkeys are always
    // permitted by policy and remain usable as the phishing-resistant escape
    // hatch rather than turning a settings outage into a universal lockout.
    return { totp: false, sms: false, passkey: true };
  }
  const am = security?.allowedMethods;
  return {
    totp: am?.totp !== false,
    sms: am?.sms !== false,
    passkey: true, // always allowed — phishing-resistant
  };
}

/**
 * The POLICY RULE itself, decoupled from how the facts were read.
 *
 * `getEffectiveMfaPolicy` (below) reads the facts on a fresh system-context
 * connection, which is right for every caller whose subject rows are already
 * COMMITTED. `/register-partner` is the one caller where they are not: it
 * creates the partner, role and membership inside an open transaction and
 * mints the auto-login token before that transaction commits, so a second
 * pooled connection under READ COMMITTED sees NONE of those rows (it reads
 * roleForceMfa=false and no partner row — a silent empty read that looks
 * exactly like "no policy"). That site therefore reads the facts itself,
 * INSIDE its own transaction, and applies the rule here — so strictest-wins
 * and the kill-switch semantics stay single-sourced.
 *
 * `settingsUnavailable` plus the fail-closed flags reproduce the same
 * disposition getEffectiveMfaPolicy applies to a settings-read error.
 */
export function combineMfaPolicyFacts(facts: {
  roleForceMfa: boolean;
  security: MfaSecuritySettings | undefined;
  settingsUnavailable?: boolean;
  failClosed?: boolean;
  failClosedMethods?: boolean;
  /**
   * #5306 — this user's grace state, read by the caller. Omit it (or pass null)
   * to keep the pre-feature behaviour: role force is enforced immediately.
   */
  grace?: MfaGraceFacts | null;
}): EffectiveMfaPolicy {
  const killSwitchOff = !mfaForcePartnerAdmin();
  const settingsRequireMfa = facts.security?.requireMfa === true;
  // Kill switch suppresses ONLY the role-force component; settings-driven
  // requireMfa is enforced regardless (overseer hardening decision).
  let roleForceApplies = facts.roleForceMfa && !killSwitchOff;

  // #5306. Only the role axis is postponed, and only when it is the ONLY reason
  // MFA would be required — if settings already require it there is no window to
  // give, and a user who holds a factor stays required so the control gates
  // (self-disable, last-passkey removal) keep refusing mid-window.
  let pendingEnrollment: { deadline: string } | null = null;
  let graceWindow: 'active' | 'expired' | 'none' = 'none';
  const grace = facts.grace;
  if (roleForceApplies && !settingsRequireMfa && grace && !grace.hasFactor && grace.deadline) {
    if (grace.expired) {
      graceWindow = 'expired';
    } else {
      graceWindow = 'active';
      pendingEnrollment = { deadline: grace.deadline.toISOString() };
      roleForceApplies = false;
    }
  }

  const required =
    roleForceApplies
    || settingsRequireMfa
    || (facts.settingsUnavailable === true && facts.failClosed === true);

  return {
    required,
    allowedMethods: methodsFromSettings(
      facts.security,
      facts.settingsUnavailable === true,
      facts.failClosedMethods === true,
    ),
    pendingEnrollment,
    source: { roleForceMfa: facts.roleForceMfa, settingsRequireMfa, killSwitchOff, graceWindow },
  };
}

/**
 * @param opts.failClosed  Login gates FAIL OPEN on a settings-read
 *   error (a transient blip must never mass-lock a tenant out of signing in).
 *   CONTROL gates that *relax* protection on a false `required` — self-disable
 *   (`/mfa/disable`) and last-factor removal (`DELETE /passkeys/:id`) — must
 *   pass `failClosed: true` so a transient read error cannot let a user strip
 *   org/partner-required MFA. On a read error under `failClosed`, `required`
 *   is forced true (the role-force axis is unaffected — its join is outside
 *   the settings try/catch and already enforces regardless).
 * @param opts.failClosedMethods Factor enrollment/use gates pass this option.
 *   If settings cannot be read, tenant-disableable TOTP and SMS are denied;
 *   passkeys remain allowed because policy cannot disable them.
 */
/**
 * Read-only `security` settings for a scope, resolved exactly the way
 * `getEffectiveMfaPolicy` resolves them (partner-inherited for org scope via
 * `getEffectiveOrgSettings`, partner's own row for partner scope). Exists for
 * callers that need the setting WITHOUT the role-force read or the
 * enrolment-grace grant write — e.g. the Admin → Users list, which derives an
 * MFA status column for many users off one settings read rather than one
 * `getEffectiveMfaPolicy` call (and its grant side effect) per row.
 *
 * Fails open (`undefined`) on a read error, same disposition as
 * `getEffectiveMfaPolicy`'s settings branch when neither fail-closed flag is
 * set — a transient blip must not make an admin list look wrong, and
 * `resolveMfaGraceDays(undefined)` already falls back to the documented
 * default.
 */
export async function getScopeSecuritySettings(
  input: Pick<MfaPolicyInput, 'scope' | 'orgId' | 'partnerId'>,
): Promise<MfaSecuritySettings | undefined> {
  if (input.scope === 'system') return undefined;

  return dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(async () => {
      try {
        if (input.scope === 'organization' && input.orgId) {
          const { effective } = await getEffectiveOrgSettings(input.orgId);
          return effective.security as MfaSecuritySettings | undefined;
        }
        if (input.scope === 'partner' && input.partnerId) {
          const [partner] = await dbModule.db
            .select({ settings: partners.settings })
            .from(partners)
            .where(eq(partners.id, input.partnerId))
            .limit(1);
          const settings = (partner?.settings ?? {}) as Record<string, unknown>;
          return settings.security as MfaSecuritySettings | undefined;
        }
        return undefined;
      } catch (err) {
        console.error('[mfa-policy] getScopeSecuritySettings read failed — failing open (undefined):', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        return undefined;
      }
    }),
  );
}

export async function getEffectiveMfaPolicy(
  input: MfaPolicyInput,
  opts?: { failClosed?: boolean; failClosedMethods?: boolean },
): Promise<EffectiveMfaPolicy> {
  if (input.scope === 'system') {
    return {
      required: false,
      allowedMethods: { totp: true, sms: true, passkey: true },
      pendingEnrollment: null,
      source: {
        roleForceMfa: false,
        settingsRequireMfa: false,
        killSwitchOff: !mfaForcePartnerAdmin(),
        graceWindow: 'none',
      },
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
        const closedAxes = [
          opts?.failClosed ? 'required' : null,
          opts?.failClosedMethods ? 'methods' : null,
        ].filter(Boolean).join('+');
        const disposition = closedAxes
          ? `failing closed (${closedAxes})`
          : 'failing open (not required; methods allowed)';
        console.error(`[mfa-policy] effective settings read failed — ${disposition}:`, err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        security = undefined;
        settingsReadFailed = true;
      }

      // --- enrolment grace window (#5306) ---
      // Read ONLY when the role force would otherwise bite right now: the kill
      // switch is on, the role forces, and settings do not already require MFA.
      // That keeps the extra query (and the one-time grant write) off every
      // other request — including the hot middleware gate for users whose org
      // policy requires MFA anyway.
      let grace: MfaGraceFacts | null = null;
      // If the settings read failed, `security` is undefined and the window
      // length falls back to the 14-day default. That is intentional: the axis
      // this postpones is the ROLE force, which does not depend on settings, and
      // the fallback self-corrects — every later call re-reads the setting, and
      // a tenant that actually sets requireMfa returns to immediate enforcement
      // as soon as its settings are readable again. Control gates that pass
      // failClosed still end up `required` regardless (see combineMfaPolicyFacts).
      if (roleForceMfa && mfaForcePartnerAdmin() && security?.requireMfa !== true) {
        // Deliberately NOT inside the settings try/catch: like the role join, a
        // failure here is a hard error rather than an optional enrichment.
        grace = await evaluateMfaEnrollmentGrace(input.userId, resolveMfaGraceDays(security));
      }

      // Each control gate opts into the axis it must fail closed. Login leaves
      // both flags unset for availability; factor enrollment/use denies the
      // tenant-disableable methods when policy settings are unreadable.
      return combineMfaPolicyFacts({
        roleForceMfa,
        security,
        settingsUnavailable: settingsReadFailed,
        failClosed: opts?.failClosed === true,
        failClosedMethods: opts?.failClosedMethods === true,
        grace,
      });
    }),
  );
}
