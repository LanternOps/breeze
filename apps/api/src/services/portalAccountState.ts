/**
 * Portal account state machine (portal registration W2, spec §5.1 and §6
 * invariant 10). The ONLY place where a target `status` / `browser_access`
 * for a `portal_users` row is computed. Every writer of either column goes
 * through here — `__tests__/portalAccountWriters.contract.test.ts` makes each
 * `portal_users` writer either import this module or declare it writes no
 * state.
 *
 * Pure: no DB access. Callers read the row's facts, ask for a target, and
 * write it guarded by the `auth_epoch` they read (optimistic concurrency), so
 * a concurrent transition can never be overwritten by a stale plan.
 *
 * Refusal messages are the ones each route returned before W2; only the
 * machine-readable `code` is new.
 */
import type { PortalAccountStatus, PortalBrowserAccess } from '../db/schema/portal';

export const PORTAL_ACCOUNT_TRANSITION_REFUSED = 'PORTAL_ACCOUNT_TRANSITION_REFUSED';
export const PORTAL_USER_IDENTITY_MANAGED = 'PORTAL_USER_IDENTITY_MANAGED';

export type PortalAccountWriter =
  | 'msp_invite'
  | 'msp_bulk_invite'
  | 'msp_resend_invite'
  | 'msp_disable'
  | 'msp_reactivate'
  | 'accept_invite'
  // W3 (#11380): approving an add-in user's access request
  // (services/portalAccessRequests.ts). New accounts from an approved request
  // use initialPortalAccountState instead.
  | 'access_request_approve'
  // W4 (#11381): an invitation-bound Microsoft sign-in
  // (services/portalOidc/accountResolution.ts). Same rows and epoch rule as
  // accept_invite; auth_method is left unchanged (plan D13).
  | 'sso_invite_accept'
  // W4: instant-mode browser grant to an existing add-in account, and the MSP
  // "grant browser access" action. Aliases of access_request_approve; the
  // separate names exist only so the writer census and audits say which path
  // wrote.
  | 'sso_instant_grant'
  | 'msp_grant_browser_access'
  // W4: "Send Microsoft sign-in invite" to a stranded account (spec §5.11; the
  // §5.1 `active → invited` re-invite). Unlike msp_invite it accepts an active
  // account that HAS a password: under sso_only that password no longer signs
  // in, and only an invitation can bind a Microsoft identity to the account
  // (§5.6 step 2, never by email). The hash is kept (a fallback to `allowed`
  // must not strand the person); a Microsoft accept under sso_only clears it.
  | 'msp_sso_invite';

export interface PortalAccountFacts {
  status: string;
  browserAccess: string;
  authMethod: string;
  hasPasswordHash: boolean;
  /** W3: EXISTS portal_user_identities (portalUserHasIdentitySql). */
  hasExternalIdentity: boolean;
}

export interface PortalAccountTarget {
  status: PortalAccountStatus;
  browserAccess: PortalBrowserAccess;
  bumpEpoch: boolean;
}

type RefusalCode = typeof PORTAL_ACCOUNT_TRANSITION_REFUSED | typeof PORTAL_USER_IDENTITY_MANAGED;

export class PortalAccountTransitionError extends Error {
  constructor(
    readonly code: RefusalCode,
    readonly httpStatus: 409 | 400 | 403,
    readonly writer: PortalAccountWriter,
    readonly rule: string,
    message: string,
  ) {
    super(message);
    this.name = 'PortalAccountTransitionError';
  }
}

const STATUSES: ReadonlySet<string> = new Set<PortalAccountStatus>(['invited', 'active', 'disabled']);
const BROWSER_ACCESS: ReadonlySet<string> = new Set<PortalBrowserAccess>(['granted', 'none']);

const MSG_IDENTITY_MANAGED = 'This identity is managed by an external sign-in provider.';
/** accept-invite never explains a refusal to the token holder: the generic invite 400. */
const MSG_INVALID_INVITE = 'Invalid or expired invite';

/** "Password-eligible": the row may hold and use a password credential. */
export function isPasswordEligible(f: Pick<PortalAccountFacts, 'authMethod'>): boolean {
  return f.authMethod === 'password';
}

/**
 * The state a brand-new row is inserted with. An add-in login never starts with
 * browser access.
 *
 * W3 (#11380) access-request approval:
 *  - `sso_request_approved`  — an identity-only account: active and granted.
 *    The caller sets `auth_method` to the provider, never `password` (plan D2).
 *  - `self_request_approved` — the same as an MSP invite: invited and granted.
 *    The caller issues the invite.
 *
 * W4 (#11381): `sso_instant` — a first Microsoft sign-in under the instant
 * new-person mode. An alias of `sso_request_approved` (identity-only, W3 D2).
 */
export function initialPortalAccountState(
  writer: 'msp_invite' | 'addin_jit' | 'sso_request_approved' | 'self_request_approved' | 'sso_instant',
): { status: PortalAccountStatus; browserAccess: PortalBrowserAccess } {
  switch (writer) {
    case 'msp_invite':
    case 'self_request_approved':
      return { status: 'invited', browserAccess: 'granted' };
    case 'addin_jit':
      return { status: 'active', browserAccess: 'none' };
    case 'sso_request_approved':
    case 'sso_instant':
      return { status: 'active', browserAccess: 'granted' };
  }
}

/**
 * Rows bulk invite may touch: password-method, no password, no identity, and
 * `invited` or a legacy credential-less `active` row (pre-#3258 inbound email
 * created those; the MSP UI shows them as "pending setup"), so bulk invite can
 * never touch an add-in or identity-only account (W2 plan decision D2).
 */
export function isBulkInviteEligible(facts: PortalAccountFacts): boolean {
  return isPasswordEligible(facts)
    && !facts.hasPasswordHash
    && !facts.hasExternalIdentity
    && (facts.status === 'invited' || facts.status === 'active');
}

/**
 * The transition table. Throws `PortalAccountTransitionError` for a refused
 * transition, and for any stored `status` / `browser_access` outside the
 * known values (fail closed — never guess).
 */
export function planPortalAccountTransition(facts: PortalAccountFacts, writer: PortalAccountWriter): PortalAccountTarget {
  const refuse = (code: RefusalCode, httpStatus: 409 | 400 | 403, rule: string, message: string): never => {
    throw new PortalAccountTransitionError(code, httpStatus, writer, rule, message);
  };

  if (!STATUSES.has(facts.status)) {
    refuse(PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'unknown_status', 'This portal user is in an unknown state.');
  }
  if (!BROWSER_ACCESS.has(facts.browserAccess)) {
    refuse(PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'unknown_browser_access', 'This portal user is in an unknown state.');
  }
  const status = facts.status as PortalAccountStatus;
  const browserAccess = facts.browserAccess as PortalBrowserAccess;
  const inviteEligible = isPasswordEligible(facts) && !facts.hasExternalIdentity;

  switch (writer) {
    case 'msp_sso_invite': {
      if (!inviteEligible) return refuse(PORTAL_USER_IDENTITY_MANAGED, 409, 'identity_managed', MSG_IDENTITY_MANAGED);
      if (status === 'disabled') {
        return refuse(PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'disabled', 'This user is disabled. Reactivate them before inviting.');
      }
      if (browserAccess !== 'granted') {
        return refuse(PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'browser_access_none', 'Give this user browser access first.');
      }
      return { status: 'invited', browserAccess: 'granted', bumpEpoch: true };
    }
    case 'msp_invite':
    case 'msp_bulk_invite': {
      // Identity check first: today's route order (an add-in login is
      // "managed by an external sign-in provider" whatever its status).
      if (!inviteEligible) return refuse(PORTAL_USER_IDENTITY_MANAGED, 409, 'identity_managed', MSG_IDENTITY_MANAGED);
      if (status === 'disabled') {
        return refuse(PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'disabled', 'This user is disabled. Reactivate them before inviting.');
      }
      if (status === 'active' && facts.hasPasswordHash) {
        return refuse(PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'active_with_password', 'This email already has an active portal account.');
      }
      // invited, or a legacy credential-less active row.
      return { status: 'invited', browserAccess: 'granted', bumpEpoch: true };
    }

    case 'msp_resend_invite': {
      if (!inviteEligible) return refuse(PORTAL_USER_IDENTITY_MANAGED, 409, 'identity_managed', MSG_IDENTITY_MANAGED);
      if (status === 'disabled') {
        return refuse(PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'disabled', 'This user is disabled. Reactivate them first.');
      }
      if (status === 'active' && facts.hasPasswordHash) {
        return refuse(PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'active_with_password', 'This account is already set up.');
      }
      if (status === 'invited') return { status: 'invited', browserAccess, bumpEpoch: false };
      // Legacy credential-less active row: move it to invited so the invite is redeemable.
      return { status: 'invited', browserAccess: 'granted', bumpEpoch: true };
    }

    case 'msp_disable':
      return { status: 'disabled', browserAccess, bumpEpoch: true };

    case 'msp_reactivate': {
      if (status === 'active') return { status: 'active', browserAccess, bumpEpoch: false };
      if (status === 'invited') {
        return refuse(
          PORTAL_ACCOUNT_TRANSITION_REFUSED,
          409,
          'invited_not_reactivatable',
          'This user has not accepted their invite yet. Resend the invite instead.',
        );
      }
      // disabled: back to active only with a credential; otherwise to invited,
      // so an account can never be active with no way to sign in (W2 plan D4).
      // The MSP then resends the invite.
      const hasCredential = facts.hasPasswordHash || facts.hasExternalIdentity;
      return { status: hasCredential ? 'active' : 'invited', browserAccess, bumpEpoch: true };
    }

    case 'accept_invite': {
      if (status !== 'invited' || !isPasswordEligible(facts) || browserAccess !== 'granted') {
        return refuse(PORTAL_ACCOUNT_TRANSITION_REFUSED, 400, 'not_acceptable', MSG_INVALID_INVITE);
      }
      return { status: 'active', browserAccess, bumpEpoch: true };
    }

    case 'sso_invite_accept': {
      // accept_invite's rows without the password-eligibility check: the
      // credential is the identity linked in the same transaction.
      if (status !== 'invited' || browserAccess !== 'granted') {
        return refuse(PORTAL_ACCOUNT_TRANSITION_REFUSED, 400, 'not_acceptable', MSG_INVALID_INVITE);
      }
      return { status: 'active', browserAccess, bumpEpoch: true };
    }

    case 'access_request_approve':
    case 'sso_instant_grant': {
      // Grants the browser portal to an existing (add-in) account. No epoch
      // bump: granting must not kill the person's live add-in sessions.
      if (status === 'disabled') {
        return refuse(PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'disabled', 'This user is disabled. Reactivate them before approving.');
      }
      if (status === 'invited') {
        return refuse(PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'invited', 'This user has a pending invite. Resend the invite instead.');
      }
      return { status: 'active', browserAccess: 'granted', bumpEpoch: false };
    }

    case 'msp_grant_browser_access': {
      // The same rows as access_request_approve, with the MSP action's wording.
      if (status === 'disabled') {
        return refuse(PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'disabled', 'This user is disabled. Reactivate them first.');
      }
      if (status === 'invited') {
        return refuse(PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'invited', 'This user has a pending invite.');
      }
      return { status: 'active', browserAccess: 'granted', bumpEpoch: false };
    }

    default:
      return refuse(PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'unknown_writer', 'Unsupported portal account transition.');
  }
}
