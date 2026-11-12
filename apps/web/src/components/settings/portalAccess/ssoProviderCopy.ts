import type { SsoProviderSet } from './types';

/**
 * W7 (#11384): the `sso_only` and sign-in-invite copy per provider set
 * (`effectiveProviderSet` / `capabilityProviderSet` in `./types`). Microsoft
 * keeps the W4 keys unchanged; Google wording appears only when Google is in
 * the set, so a deployment without the Google capability (W7 ships dark) never
 * shows it. Keys carry the namespace so plain-`t` callers outside a
 * `useTranslation('settings')` component resolve them too. Callers pass them
 * as `t(/* i18n-dynamic *\/ SSO_COPY_KEYS.<group>[set])`.
 */
export const SSO_COPY_KEYS = {
  needsSsoError: {
    microsoft: 'settings:portalAccessPolicy.errors.ssoOnlyNeedsSsoMicrosoft',
    google: 'settings:portalAccessPolicy.errors.ssoOnlyNeedsSsoGoogle',
    both: 'settings:portalAccessPolicy.errors.ssoOnlyNeedsSso',
  },
  confirmExplain: {
    microsoft: 'settings:portalAccessPolicy.ssoOnlyConfirm.explain',
    google: 'settings:portalAccessPolicy.ssoOnlyConfirm.explainGoogle',
    both: 'settings:portalAccessPolicy.ssoOnlyConfirm.explainBoth',
  },
  confirmSendInvites: {
    microsoft: 'settings:portalAccessPolicy.ssoOnlyConfirm.sendInvites',
    google: 'settings:portalAccessPolicy.ssoOnlyConfirm.sendInvitesGoogle',
    both: 'settings:portalAccessPolicy.ssoOnlyConfirm.sendInvitesBoth',
  },
  strandedDescription: {
    microsoft: 'settings:portalAccessPolicy.stranded.description',
    google: 'settings:portalAccessPolicy.stranded.descriptionGoogle',
    both: 'settings:portalAccessPolicy.stranded.descriptionBoth',
  },
  strandedInvite: {
    microsoft: 'settings:portalAccessPolicy.stranded.invite',
    google: 'settings:portalAccessPolicy.stranded.inviteGoogle',
    both: 'settings:portalAccessPolicy.stranded.inviteBoth',
  },
  invited: {
    microsoft: 'settings:portalAccessPolicy.stranded.toasts.invited',
    google: 'settings:portalAccessPolicy.stranded.toasts.invitedGoogle',
    both: 'settings:portalAccessPolicy.stranded.toasts.invitedBoth',
  },
  partial: {
    microsoft: 'settings:portalAccessPolicy.stranded.toasts.partial',
    google: 'settings:portalAccessPolicy.stranded.toasts.partialGoogle',
    both: 'settings:portalAccessPolicy.stranded.toasts.partialBoth',
  },
  inviteError: {
    microsoft: 'settings:portalAccessPolicy.stranded.errors.invite',
    google: 'settings:portalAccessPolicy.stranded.errors.inviteGoogle',
    both: 'settings:portalAccessPolicy.stranded.errors.inviteBoth',
  },
  unavailable: {
    microsoft: 'settings:portalAccessPolicy.stranded.errors.unavailable',
    google: 'settings:portalAccessPolicy.stranded.errors.unavailableGoogle',
    both: 'settings:portalAccessPolicy.stranded.errors.unavailableBoth',
  },
} as const satisfies Record<string, Record<SsoProviderSet, string>>;
