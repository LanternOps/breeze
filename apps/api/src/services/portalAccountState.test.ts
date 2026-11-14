import { describe, expect, it } from 'vitest';
import {
  PORTAL_ACCOUNT_TRANSITION_REFUSED,
  PORTAL_USER_IDENTITY_MANAGED,
  PortalAccountTransitionError,
  initialPortalAccountState,
  isBulkInviteEligible,
  isPasswordEligible,
  passwordUsableFor,
  planPortalAccountTransition,
  type PortalAccountFacts,
  type PortalAccountWriter,
} from './portalAccountState';

/** Facts of a password-method row awaiting setup (the common invite shape). */
const f = (over: Partial<PortalAccountFacts> = {}): PortalAccountFacts => {
  const base = { status: 'invited', browserAccess: 'granted', authMethod: 'password', hasPasswordHash: false, hasExternalIdentity: false, ...over };
  // W8 (D3): the usable-credential facts default to the pre-W8 reading (every
  // identity enabled, a password-method hash usable under `allowed`) unless a
  // case sets them.
  return {
    hasUsableExternalIdentity: base.hasExternalIdentity,
    passwordUsable: base.hasPasswordHash && base.authMethod === 'password',
    ...base,
  };
};

const ACTIVE_WITH_HASH = f({ status: 'active', hasPasswordHash: true });
const ACTIVE_CREDENTIAL_LESS = f({ status: 'active', hasPasswordHash: false });
const DISABLED_WITH_HASH = f({ status: 'disabled', hasPasswordHash: true });
const DISABLED_CREDENTIAL_LESS = f({ status: 'disabled' });
const ENTRA = f({ status: 'active', authMethod: 'entra', browserAccess: 'none', hasExternalIdentity: true });
const DISABLED_ENTRA = f({ status: 'disabled', authMethod: 'entra', browserAccess: 'none', hasExternalIdentity: true });
const PASSWORD_WITH_IDENTITY = f({ status: 'invited', hasExternalIdentity: true });

type Allowed = [string, PortalAccountFacts, PortalAccountWriter, { status: string; browserAccess: string; bumpEpoch: boolean; disabledBy?: string | null }];
type Refused = [string, PortalAccountFacts, PortalAccountWriter, { code: string; httpStatus: number; message: string }];

// One row per line of the transition table in the W2 plan (Task 5).
const ALLOWED: Allowed[] = [
  ['invite: invited → invited (granted, +1)', f(), 'msp_invite', { status: 'invited', browserAccess: 'granted', bumpEpoch: true }],
  ['bulk invite: invited → invited (granted, +1)', f(), 'msp_bulk_invite', { status: 'invited', browserAccess: 'granted', bumpEpoch: true }],
  ['invite: legacy active credential-less → invited (+1)', ACTIVE_CREDENTIAL_LESS, 'msp_invite', { status: 'invited', browserAccess: 'granted', bumpEpoch: true }],
  ['bulk invite: legacy active credential-less → invited (+1)', ACTIVE_CREDENTIAL_LESS, 'msp_bulk_invite', { status: 'invited', browserAccess: 'granted', bumpEpoch: true }],
  // W4 (#11381, spec §5.1 re-invite + §5.11): the SSO invite to a stranded account.
  ['sso invite: active with a password → invited (granted, +1); the hash is kept', ACTIVE_WITH_HASH, 'msp_sso_invite', { status: 'invited', browserAccess: 'granted', bumpEpoch: true }],
  ['sso invite: legacy active credential-less → invited (+1)', ACTIVE_CREDENTIAL_LESS, 'msp_sso_invite', { status: 'invited', browserAccess: 'granted', bumpEpoch: true }],
  ['sso invite: invited → invited (+1)', f({ browserAccess: 'granted' }), 'msp_sso_invite', { status: 'invited', browserAccess: 'granted', bumpEpoch: true }],
  ['resend: invited stays invited, browser access unchanged, no epoch bump', f({ browserAccess: 'granted' }), 'msp_resend_invite', { status: 'invited', browserAccess: 'granted', bumpEpoch: false }],
  ['resend: active credential-less → invited (granted, +1) so the token is redeemable', ACTIVE_CREDENTIAL_LESS, 'msp_resend_invite', { status: 'invited', browserAccess: 'granted', bumpEpoch: true }],
  ['disable: invited → disabled (+1)', f(), 'msp_disable', { status: 'disabled', browserAccess: 'granted', bumpEpoch: true }],
  ['disable: active → disabled (+1)', ACTIVE_WITH_HASH, 'msp_disable', { status: 'disabled', browserAccess: 'granted', bumpEpoch: true }],
  ['disable: disabled → disabled (+1)', DISABLED_WITH_HASH, 'msp_disable', { status: 'disabled', browserAccess: 'granted', bumpEpoch: true }],
  ['disable: an add-in login keeps browser_access none', ENTRA, 'msp_disable', { status: 'disabled', browserAccess: 'none', bumpEpoch: true }],
  ['reactivate: disabled with a password → active (+1)', DISABLED_WITH_HASH, 'msp_reactivate', { status: 'active', browserAccess: 'granted', bumpEpoch: true }],
  ['reactivate: disabled with an identity → active (+1), browser access unchanged', DISABLED_ENTRA, 'msp_reactivate', { status: 'active', browserAccess: 'none', bumpEpoch: true }],
  ['reactivate: disabled credential-less → invited (D4)', DISABLED_CREDENTIAL_LESS, 'msp_reactivate', { status: 'invited', browserAccess: 'granted', bumpEpoch: true }],
  ['reactivate: active is a no-op', ACTIVE_WITH_HASH, 'msp_reactivate', { status: 'active', browserAccess: 'granted', bumpEpoch: false }],
  ['accept-invite: invited → active (+1)', f(), 'accept_invite', { status: 'active', browserAccess: 'granted', bumpEpoch: true }],
  // W3 (#11380): approving an add-in user's access request grants the browser
  // portal and must not bump the epoch (that would kill their add-in sessions).
  ['access request approve: active + none → granted, no epoch bump', ENTRA, 'access_request_approve', { status: 'active', browserAccess: 'granted', bumpEpoch: false }],
  ['access request approve: active + granted is idempotent', f({ status: 'active', authMethod: 'entra', hasExternalIdentity: true }), 'access_request_approve', { status: 'active', browserAccess: 'granted', bumpEpoch: false }],
  // W4 (#11381): an invitation-bound Microsoft sign-in activates like
  // accept-invite (same epoch rule); auth_method is left as it is (D13).
  ['sso invite accept: invited + granted → active (+1)', f(), 'sso_invite_accept', { status: 'active', browserAccess: 'granted', bumpEpoch: true }],
  // W4: instant mode and the MSP browser-access grant are aliases of the
  // access_request_approve rows — no epoch bump, so add-in sessions survive.
  ['sso instant grant: active + none → granted, no epoch bump', ENTRA, 'sso_instant_grant', { status: 'active', browserAccess: 'granted', bumpEpoch: false }],
  ['sso instant grant: active + granted is unchanged', f({ status: 'active', authMethod: 'entra', hasExternalIdentity: true }), 'sso_instant_grant', { status: 'active', browserAccess: 'granted', bumpEpoch: false }],
  ['msp grant browser access: active + none → granted, no epoch bump', ENTRA, 'msp_grant_browser_access', { status: 'active', browserAccess: 'granted', bumpEpoch: false }],
  ['msp grant browser access: active + granted is unchanged', ACTIVE_WITH_HASH, 'msp_grant_browser_access', { status: 'active', browserAccess: 'granted', bumpEpoch: false }],
];

const REFUSED: Refused[] = [
  ['invite: an add-in (entra) login is identity-managed', ENTRA, 'msp_invite', { code: PORTAL_USER_IDENTITY_MANAGED, httpStatus: 409, message: 'This identity is managed by an external sign-in provider.' }],
  ['invite: a password row that carries an identity is identity-managed', PASSWORD_WITH_IDENTITY, 'msp_invite', { code: PORTAL_USER_IDENTITY_MANAGED, httpStatus: 409, message: 'This identity is managed by an external sign-in provider.' }],
  ['invite: identity check wins over the disabled check (today\'s order)', DISABLED_ENTRA, 'msp_invite', { code: PORTAL_USER_IDENTITY_MANAGED, httpStatus: 409, message: 'This identity is managed by an external sign-in provider.' }],
  ['invite: active with a password', ACTIVE_WITH_HASH, 'msp_invite', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, message: 'This email already has an active portal account.' }],
  ['sso invite: an add-in (entra) login is identity-managed', ENTRA, 'msp_sso_invite', { code: PORTAL_USER_IDENTITY_MANAGED, httpStatus: 409, message: 'This identity is managed by an external sign-in provider.' }],
  ['sso invite: a password row that carries an identity is identity-managed', PASSWORD_WITH_IDENTITY, 'msp_sso_invite', { code: PORTAL_USER_IDENTITY_MANAGED, httpStatus: 409, message: 'This identity is managed by an external sign-in provider.' }],
  ['sso invite: disabled', DISABLED_WITH_HASH, 'msp_sso_invite', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, message: 'This user is disabled. Reactivate them before inviting.' }],
  ['sso invite: browser access none (an add-in-only password row)', f({ status: 'active', hasPasswordHash: true, browserAccess: 'none' }), 'msp_sso_invite', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, message: 'Give this user browser access first.' }],
  ['invite: disabled', DISABLED_CREDENTIAL_LESS, 'msp_invite', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, message: 'This user is disabled. Reactivate them before inviting.' }],
  ['bulk invite: active with a password', ACTIVE_WITH_HASH, 'msp_bulk_invite', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, message: 'This email already has an active portal account.' }],
  ['bulk invite: an add-in login', ENTRA, 'msp_bulk_invite', { code: PORTAL_USER_IDENTITY_MANAGED, httpStatus: 409, message: 'This identity is managed by an external sign-in provider.' }],
  ['resend: an add-in login', ENTRA, 'msp_resend_invite', { code: PORTAL_USER_IDENTITY_MANAGED, httpStatus: 409, message: 'This identity is managed by an external sign-in provider.' }],
  ['resend: disabled', DISABLED_CREDENTIAL_LESS, 'msp_resend_invite', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, message: 'This user is disabled. Reactivate them first.' }],
  ['resend: already set up', ACTIVE_WITH_HASH, 'msp_resend_invite', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, message: 'This account is already set up.' }],
  ['reactivate: invited (never via PATCH)', f(), 'msp_reactivate', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, message: 'This user has not accepted their invite yet. Resend the invite instead.' }],
  ['accept-invite: active', ACTIVE_CREDENTIAL_LESS, 'accept_invite', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 400, message: 'Invalid or expired invite' }],
  ['accept-invite: disabled', DISABLED_CREDENTIAL_LESS, 'accept_invite', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 400, message: 'Invalid or expired invite' }],
  ['accept-invite: an add-in login', f({ authMethod: 'entra', browserAccess: 'none', hasExternalIdentity: true }), 'accept_invite', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 400, message: 'Invalid or expired invite' }],
  ['accept-invite: browser_access none', f({ browserAccess: 'none' }), 'accept_invite', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 400, message: 'Invalid or expired invite' }],
  ['access request approve: disabled', DISABLED_ENTRA, 'access_request_approve', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, message: 'This user is disabled. Reactivate them before approving.' }],
  ['access request approve: invited', f(), 'access_request_approve', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, message: 'This user has a pending invite. Resend the invite instead.' }],
  ['sso invite accept: active', ACTIVE_CREDENTIAL_LESS, 'sso_invite_accept', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 400, message: 'Invalid or expired invite' }],
  ['sso invite accept: disabled', DISABLED_CREDENTIAL_LESS, 'sso_invite_accept', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 400, message: 'Invalid or expired invite' }],
  ['sso invite accept: invited with browser_access none', f({ browserAccess: 'none' }), 'sso_invite_accept', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 400, message: 'Invalid or expired invite' }],
  ['sso instant grant: disabled', DISABLED_ENTRA, 'sso_instant_grant', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, message: 'This user is disabled. Reactivate them before approving.' }],
  ['sso instant grant: invited', f(), 'sso_instant_grant', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, message: 'This user has a pending invite. Resend the invite instead.' }],
  ['msp grant browser access: disabled', DISABLED_ENTRA, 'msp_grant_browser_access', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, message: 'This user is disabled. Reactivate them first.' }],
  ['msp grant browser access: invited', f(), 'msp_grant_browser_access', { code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, message: 'This user has a pending invite.' }],
];

describe('planPortalAccountTransition — allowed transitions', () => {
  it.each(ALLOWED)('%s', (_name, facts, writer, target) => {
    // W8 (D2): every target names who disabled the account; in the W2 table
    // only msp_disable lands on disabled, so the default is 'msp' or null.
    const disabledBy = target.disabledBy !== undefined ? target.disabledBy : target.status === 'disabled' ? 'msp' : null;
    expect(planPortalAccountTransition(facts, writer)).toEqual({ ...target, disabledBy });
  });
});

describe('planPortalAccountTransition — refusals', () => {
  it.each(REFUSED)('%s', (_name, facts, writer, refusal) => {
    let caught: unknown;
    try {
      planPortalAccountTransition(facts, writer);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PortalAccountTransitionError);
    const err = caught as PortalAccountTransitionError;
    expect({ code: err.code, httpStatus: err.httpStatus, message: err.message }).toEqual(refusal);
    expect(err.writer).toBe(writer);
    expect(typeof err.rule).toBe('string');
  });
});

describe('planPortalAccountTransition — fail closed on unknown input', () => {
  it('throws on an unknown stored status rather than guessing', () => {
    expect(() => planPortalAccountTransition(f({ status: 'pending' }), 'msp_disable')).toThrow(PortalAccountTransitionError);
    expect(() => planPortalAccountTransition(f({ status: ' Active ' }), 'msp_reactivate')).toThrow(PortalAccountTransitionError);
  });

  it('throws on an unknown stored browser_access', () => {
    expect(() => planPortalAccountTransition(f({ browserAccess: 'maybe' }), 'msp_disable')).toThrow(PortalAccountTransitionError);
  });

  it('throws on an unknown writer', () => {
    expect(() => planPortalAccountTransition(f(), 'scim_provision' as PortalAccountWriter)).toThrow(PortalAccountTransitionError);
  });

  it('no W2 writer moves a none row to granted', () => {
    const noneRow = f({ status: 'disabled', authMethod: 'entra', browserAccess: 'none', hasExternalIdentity: true });
    for (const writer of ['msp_invite', 'msp_bulk_invite', 'msp_resend_invite', 'msp_disable', 'msp_reactivate', 'accept_invite'] as const) {
      try {
        expect(planPortalAccountTransition(noneRow, writer).browserAccess).toBe('none');
      } catch (error) {
        expect(error).toBeInstanceOf(PortalAccountTransitionError);
      }
    }
  });
});

describe('initialPortalAccountState', () => {
  it('an MSP invite starts invited with browser access', () => {
    expect(initialPortalAccountState('msp_invite')).toEqual({ status: 'invited', browserAccess: 'granted' });
  });

  it('add-in JIT never starts with browser access', () => {
    expect(initialPortalAccountState('addin_jit')).toEqual({ status: 'active', browserAccess: 'none' });
  });

  it('an approved SSO request starts active with browser access (identity-only account, D2)', () => {
    expect(initialPortalAccountState('sso_request_approved')).toEqual({ status: 'active', browserAccess: 'granted' });
  });

  it('an approved self-registration request starts invited with browser access, like an MSP invite', () => {
    expect(initialPortalAccountState('self_request_approved')).toEqual({ status: 'invited', browserAccess: 'granted' });
  });

  it('self_registration_instant yields invited + granted, like an approved self request (W6, inv. 10)', () => {
    expect(initialPortalAccountState('self_registration_instant')).toEqual({ status: 'invited', browserAccess: 'granted' });
  });

  it('an instant-mode SSO account starts active with browser access, like an approved SSO request (W4)', () => {
    expect(initialPortalAccountState('sso_instant')).toEqual({ status: 'active', browserAccess: 'granted' });
  });
});

describe('isPasswordEligible / isBulkInviteEligible', () => {
  it('password-eligible means auth_method password', () => {
    expect(isPasswordEligible({ authMethod: 'password' })).toBe(true);
    expect(isPasswordEligible({ authMethod: 'entra' })).toBe(false);
  });

  it('bulk invite excludes identity, entra, disabled and passworded rows', () => {
    expect(isBulkInviteEligible(f())).toBe(true);
    expect(isBulkInviteEligible(ACTIVE_CREDENTIAL_LESS)).toBe(true);
    expect(isBulkInviteEligible(ENTRA)).toBe(false);
    expect(isBulkInviteEligible(PASSWORD_WITH_IDENTITY)).toBe(false);
    expect(isBulkInviteEligible(DISABLED_CREDENTIAL_LESS)).toBe(false);
    expect(isBulkInviteEligible(ACTIVE_WITH_HASH)).toBe(false);
    expect(isBulkInviteEligible(f({ hasPasswordHash: true }))).toBe(false);
    expect(isBulkInviteEligible(f({ status: 'pending' }))).toBe(false);
  });
});

// ===========================================================================
// W8 (#11385, plan D2/D3): directory_deprovision, disabled_by and the
// usable-credential facts. Appended; every case above is unchanged.
// ===========================================================================

describe('W8 — directory_deprovision and disabled_by', () => {
  it('directory_deprovision is in the writer census and yields disabled + disabled_by directory + bumpEpoch', () => {
    // inv. 10: the state module plans it; browser access is left as it is.
    expect(planPortalAccountTransition(ACTIVE_WITH_HASH, 'directory_deprovision'))
      .toEqual({ status: 'disabled', browserAccess: 'granted', bumpEpoch: true, disabledBy: 'directory' });
    expect(planPortalAccountTransition(f(), 'directory_deprovision'))
      .toEqual({ status: 'disabled', browserAccess: 'granted', bumpEpoch: true, disabledBy: 'directory' });
    expect(planPortalAccountTransition(ENTRA, 'directory_deprovision'))
      .toEqual({ status: 'disabled', browserAccess: 'none', bumpEpoch: true, disabledBy: 'directory' });
  });

  it('directory_deprovision on a disabled account is a no-op that keeps disabled_by', () => {
    // RF4: an MSP disable stays the MSP's; nothing in W8 overwrites it.
    for (const by of ['msp', 'directory', 'scim'] as const) {
      expect(planPortalAccountTransition(f({ status: 'disabled', disabledBy: by }), 'directory_deprovision'))
        .toEqual({ status: 'disabled', browserAccess: 'granted', bumpEpoch: false, disabledBy: by });
    }
  });

  it('directory_deprovision on a disabled account whose disabled_by is unknown fails closed', () => {
    expect(() => planPortalAccountTransition(f({ status: 'disabled' }), 'directory_deprovision')).toThrow(PortalAccountTransitionError);
    expect(() => planPortalAccountTransition(f({ status: 'disabled', disabledBy: null }), 'directory_deprovision')).toThrow(PortalAccountTransitionError);
    expect(() => planPortalAccountTransition(f({ status: 'disabled', disabledBy: 'nobody' as never }), 'directory_deprovision')).toThrow(PortalAccountTransitionError);
  });

  it('msp_disable always sets disabled_by msp, also over a directory disable', () => {
    expect(planPortalAccountTransition(f({ status: 'disabled', disabledBy: 'directory' }), 'msp_disable'))
      .toEqual({ status: 'disabled', browserAccess: 'granted', bumpEpoch: true, disabledBy: 'msp' });
  });

  it('every transition out of disabled clears disabled_by', () => {
    const writers: PortalAccountWriter[] = [
      'msp_invite', 'msp_bulk_invite', 'msp_resend_invite', 'msp_disable', 'msp_reactivate', 'accept_invite',
      'access_request_approve', 'sso_invite_accept', 'sso_instant_grant', 'msp_grant_browser_access', 'msp_sso_invite',
      'directory_deprovision',
    ];
    const rows: PortalAccountFacts[] = [];
    for (const status of ['invited', 'active', 'disabled']) {
      for (const browserAccess of ['granted', 'none']) {
        for (const authMethod of ['password', 'entra']) {
          for (const hasPasswordHash of [false, true]) {
            for (const hasExternalIdentity of [false, true]) {
              for (const usable of [false, true]) {
                rows.push(f({
                  status, browserAccess, authMethod, hasPasswordHash, hasExternalIdentity,
                  hasUsableExternalIdentity: hasExternalIdentity && usable,
                  passwordUsable: hasPasswordHash && usable,
                  ...(status === 'disabled' ? { disabledBy: 'directory' as const } : {}),
                }));
              }
            }
          }
        }
      }
    }
    let planned = 0;
    let leftDisabled = 0;
    for (const writer of writers) {
      for (const facts of rows) {
        let target;
        try {
          target = planPortalAccountTransition(facts, writer);
        } catch (error) {
          expect(error).toBeInstanceOf(PortalAccountTransitionError);
          continue;
        }
        planned++;
        // portal_users_disabled_by_status_chk, as a property of every plan.
        expect(target.disabledBy !== null, `${writer} from ${facts.status}`).toBe(target.status === 'disabled');
        if (facts.status === 'disabled' && target.status !== 'disabled') {
          leftDisabled++;
          expect(target.disabledBy).toBeNull();
        }
        // Only these writers cross the disabled boundary, so only they must write disabled_by.
        if ((facts.status === 'disabled') !== (target.status === 'disabled')) {
          expect(['msp_disable', 'msp_reactivate', 'directory_deprovision']).toContain(writer);
        }
      }
    }
    expect(planned).toBeGreaterThan(100);
    expect(leftDisabled).toBeGreaterThan(0);
  });
});

describe('W8 — usable credentials (D3)', () => {
  it('msp_reactivate of an account whose only identity is disabled returns it to invited', () => {
    // spec §5.1: no usable credential → invited, never active.
    const onlyDisabledIdentity = f({
      status: 'disabled', disabledBy: 'directory', authMethod: 'entra', browserAccess: 'none',
      hasExternalIdentity: true, hasUsableExternalIdentity: false,
    });
    expect(planPortalAccountTransition(onlyDisabledIdentity, 'msp_reactivate'))
      .toEqual({ status: 'invited', browserAccess: 'none', bumpEpoch: true, disabledBy: null });
  });

  it('msp_reactivate of an account with a hash under sso_only and no usable identity returns it to invited', () => {
    // quorum D1: a hash that cannot sign in is not a credential.
    const ssoOnlyHash = f({ status: 'disabled', disabledBy: 'msp', hasPasswordHash: true, passwordUsable: false, hasExternalIdentity: false });
    expect(planPortalAccountTransition(ssoOnlyHash, 'msp_reactivate'))
      .toEqual({ status: 'invited', browserAccess: 'granted', bumpEpoch: true, disabledBy: null });
  });

  it('msp_reactivate with a usable identity or a usable password returns to active', () => {
    expect(planPortalAccountTransition(f({ status: 'disabled', disabledBy: 'msp', hasExternalIdentity: true, hasUsableExternalIdentity: true }), 'msp_reactivate'))
      .toMatchObject({ status: 'active', disabledBy: null });
    expect(planPortalAccountTransition(f({ status: 'disabled', disabledBy: 'directory', hasPasswordHash: true, passwordUsable: true, hasExternalIdentity: true, hasUsableExternalIdentity: false }), 'msp_reactivate'))
      .toMatchObject({ status: 'active', disabledBy: null });
  });

  it('msp_reactivate refuses (fail closed) when the caller did not supply the usable-credential facts', () => {
    const missing: PortalAccountFacts = { status: 'disabled', browserAccess: 'granted', authMethod: 'password', hasPasswordHash: true, hasExternalIdentity: false };
    expect(() => planPortalAccountTransition(missing, 'msp_reactivate')).toThrow(PortalAccountTransitionError);
  });

  it('bulk invite still skips an account whose only identity is disabled (the any-identity fact)', () => {
    expect(isBulkInviteEligible(f({ hasExternalIdentity: true, hasUsableExternalIdentity: false }))).toBe(false);
  });

  it('passwordUsableFor: a hash, password-eligible, and an effective allowed mode', () => {
    expect(passwordUsableFor({ hasPasswordHash: true, authMethod: 'password' }, 'allowed')).toBe(true);
    expect(passwordUsableFor({ hasPasswordHash: true, authMethod: 'password' }, 'sso_only')).toBe(false);
    expect(passwordUsableFor({ hasPasswordHash: false, authMethod: 'password' }, 'allowed')).toBe(false);
    expect(passwordUsableFor({ hasPasswordHash: true, authMethod: 'entra' }, 'allowed')).toBe(false);
  });
});
