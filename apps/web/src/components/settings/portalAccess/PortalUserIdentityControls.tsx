import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import {
  isDirectoryDisabled,
  type PortalAccountDisabledBy,
  type PortalDirectorySource,
  type PortalIdentityBlocker,
  type PortalUserIdentityState,
} from './types';

/**
 * Portal registration W8 (#11385, plan Task 10; D9, OD3): a portal user's
 * disabled sign-in methods in the MSP users list — the badge naming every
 * blocker, and the Restore and Remove dialogs. The list owns the requests
 * (through `runAction`); these components only collect the MSP's choice.
 */

export interface IdentityTargetUser {
  id: string;
  email: string;
  status: string;
  disabledBy?: PortalAccountDisabledBy | null;
}

export interface IdentityTarget {
  user: IdentityTargetUser;
  identity: PortalUserIdentityState;
}

export interface RestoreChoice {
  reactivateAccount: boolean;
  confirmMspDisabled: boolean;
}

const PROVIDER_DISABLED_KEYS: Record<PortalDirectorySource, string> = {
  entra: 'portalDirectory.users.disabledEntra',
  google: 'portalDirectory.users.disabledGoogle',
};

const PROVIDER_KEYS: Record<PortalDirectorySource, string> = {
  entra: 'portalDirectory.sources.entra',
  google: 'portalDirectory.sources.google',
};

const BLOCKER_KEYS: Record<PortalIdentityBlocker, string> = {
  entra_directory: 'portalDirectory.blockers.entra_directory',
  google_directory: 'portalDirectory.blockers.google_directory',
  scim: 'portalDirectory.blockers.scim',
  msp: 'portalDirectory.blockers.msp',
};

const DISABLED_BY_KEYS: Record<PortalAccountDisabledBy, string> = {
  msp: 'portalDirectory.users.disabledBy.msp',
  directory: 'portalDirectory.users.disabledBy.directory',
  scim: 'portalDirectory.users.disabledBy.scim',
};

function useBlockerList(blockers: PortalIdentityBlocker[]): string {
  const { t } = useTranslation('settings');
  return blockers.map((b) => t(/* i18n-dynamic */ BLOCKER_KEYS[b] ?? 'portalDirectory.blockers.unknown')).join(', ');
}

/** "Disabled by your team" / "Disabled by directory" beside a disabled account's status. */
export function AccountDisabledBy({ userId, disabledBy }: { userId: string; disabledBy: PortalAccountDisabledBy }) {
  const { t } = useTranslation('settings');
  const key = DISABLED_BY_KEYS[disabledBy];
  if (!key) return null;
  return (
    <span data-testid={`portal-user-disabled-by-${userId}`} className="ml-1 text-xs text-muted-foreground">
      {t(/* i18n-dynamic */ key)}
    </span>
  );
}

/** One disabled sign-in method: the badge, then Restore and (directory blockers only) Remove. */
export function DisabledIdentityBadge({
  identity,
  busy,
  onRestore,
  onRemove,
}: {
  identity: PortalUserIdentityState;
  busy: boolean;
  onRestore: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('settings');
  const blockers = useBlockerList(identity.disabledBlockers);
  return (
    <span className="ml-1 inline-flex flex-wrap items-center gap-1">
      <span
        data-testid={`identity-directory-disabled-${identity.id}`}
        title={blockers}
        className="inline-flex rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700"
      >
        {t(/* i18n-dynamic */ PROVIDER_DISABLED_KEYS[identity.provider], { blockers })}
      </span>
      <button
        type="button"
        data-testid={`portal-user-identity-restore-${identity.id}`}
        disabled={busy}
        onClick={onRestore}
        className="rounded-md border px-2 py-0.5 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
      >
        {t('portalDirectory.users.restore')}
      </button>
      {isDirectoryDisabled(identity) && (
        <button
          type="button"
          data-testid={`portal-user-identity-remove-${identity.id}`}
          disabled={busy}
          onClick={onRemove}
          className="rounded-md border px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50"
        >
          {t('portalDirectory.users.remove')}
        </button>
      )}
    </span>
  );
}

/**
 * Restore (D9): clears every blocker. With "Also re-enable the account" the
 * account is reactivated too. Checked by default only when the directory
 * disabled it; an account the MSP disabled needs a second, explicit
 * confirmation (the API refuses otherwise with PORTAL_ACCOUNT_MSP_DISABLED_CONFIRM).
 */
export function RestoreIdentityDialog({
  target,
  busy,
  onCancel,
  onConfirm,
}: {
  target: IdentityTarget | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (choice: RestoreChoice) => void;
}) {
  const { t } = useTranslation('settings');
  const accountDisabled = target?.user.status === 'disabled';
  const mspDisabled = accountDisabled && target?.user.disabledBy === 'msp';
  const [reactivate, setReactivate] = useState(false);
  const [confirmMsp, setConfirmMsp] = useState(false);
  const blockers = useBlockerList(target?.identity.disabledBlockers ?? []);

  // A new target resets the choice: re-enable by default only for a directory disable.
  useEffect(() => {
    setReactivate(Boolean(target && target.user.status === 'disabled' && target.user.disabledBy !== 'msp'));
    setConfirmMsp(false);
  }, [target]);

  const reactivateAccount = accountDisabled && reactivate;
  const needsMspConfirm = reactivateAccount && mspDisabled;

  return (
    <ConfirmDialog
      open={target !== null}
      onClose={() => { if (!busy) onCancel(); }}
      onConfirm={() => onConfirm({ reactivateAccount, confirmMspDisabled: needsMspConfirm && confirmMsp })}
      title={t('portalDirectory.restore.title')}
      message={target
        ? t('portalDirectory.restore.message', {
          provider: t(/* i18n-dynamic */ PROVIDER_KEYS[target.identity.provider]),
          email: target.user.email,
          blockers,
        })
        : ''}
      confirmLabel={t('portalDirectory.users.restore')}
      variant="warning"
      isLoading={busy}
      confirmDisabled={needsMspConfirm && !confirmMsp}
      confirmTestId="portal-user-restore-confirm"
      dialogTestId="portal-user-restore-dialog"
    >
      <p className="mt-2 text-xs text-muted-foreground">{t('portalDirectory.restore.rearmNote')}</p>
      {accountDisabled && (
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="portal-user-restore-reactivate"
            checked={reactivate}
            onChange={(e) => { setReactivate(e.target.checked); setConfirmMsp(false); }}
            className="mt-0.5"
          />
          <span>{t('portalDirectory.restore.reactivate')}</span>
        </label>
      )}
      {needsMspConfirm && (
        <label className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-sm">
          <input
            type="checkbox"
            data-testid="portal-user-restore-confirm-msp"
            checked={confirmMsp}
            onChange={(e) => setConfirmMsp(e.target.checked)}
            className="mt-0.5"
          />
          <span>{t('portalDirectory.restore.confirmMsp')}</span>
        </label>
      )}
    </ConfirmDialog>
  );
}

/** Remove (OD3): deletes one sign-in method the customer's directory disabled. */
export function RemoveIdentityDialog({
  target,
  busy,
  onCancel,
  onConfirm,
}: {
  target: IdentityTarget | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <ConfirmDialog
      open={target !== null}
      onClose={() => { if (!busy) onCancel(); }}
      onConfirm={onConfirm}
      title={t('portalDirectory.remove.title')}
      message={target
        ? t('portalDirectory.remove.message', {
          provider: t(/* i18n-dynamic */ PROVIDER_KEYS[target.identity.provider]),
          email: target.user.email,
        })
        : ''}
      confirmLabel={t('portalDirectory.users.remove')}
      variant="destructive"
      isLoading={busy}
      confirmTestId="portal-user-identity-remove-confirm"
      dialogTestId="portal-user-identity-remove-dialog"
    />
  );
}
