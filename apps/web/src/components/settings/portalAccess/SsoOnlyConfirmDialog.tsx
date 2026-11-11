import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import type { SsoOnlyImpact, StrandedPortalAccounts } from './types';

/** How many stranded names the dialog lists before "and N more". */
const STRANDED_NAMES_SHOWN = 10;

export interface SsoOnlyConfirmDialogProps {
  open: boolean;
  /** `org`: the org card (stranded names, optional invites). `partner`: the header Save (per-org links). */
  scope: 'org' | 'partner';
  impact: SsoOnlyImpact | null;
  /** Org scope: the org's stranded accounts; `null` while loading or when the load failed. */
  stranded?: StrandedPortalAccounts | null;
  strandedLoadFailed?: boolean;
  /** The server answered a confirmed save with a NEW impact: the numbers moved since the dialog opened. */
  changed?: boolean;
  busy?: boolean;
  onConfirm: (opts: { sendInvites: boolean }) => void;
  onCancel: () => void;
}

/**
 * The `sso_only` save confirmation (portal registration W4 #11381, D12). The
 * PATCH that flips some org to effective `sso_only` is refused with 409 and the
 * impact; this shows that impact, and Confirm re-sends the save acknowledging
 * its digest. Presentational: the owner sends the requests.
 */
export function SsoOnlyConfirmDialog({
  open,
  scope,
  impact,
  stranded = null,
  strandedLoadFailed = false,
  changed = false,
  busy = false,
  onConfirm,
  onCancel,
}: SsoOnlyConfirmDialogProps) {
  const { t } = useTranslation('settings');
  const [sendInvites, setSendInvites] = useState(false);
  useEffect(() => { if (!open) setSendInvites(false); }, [open]);

  const flips = impact?.flips ?? [];
  const strandedTotal = flips.reduce((sum, f) => sum + f.strandedTotal, 0);
  const shownNames = (stranded?.items ?? []).slice(0, STRANDED_NAMES_SHOWN);
  const moreNames = Math.max(0, (stranded?.total ?? 0) - shownNames.length);
  const showInvites = scope === 'org' && strandedTotal > 0;

  return (
    <ConfirmDialog
      open={open}
      onClose={onCancel}
      onConfirm={() => onConfirm({ sendInvites: showInvites && sendInvites })}
      title={t('portalAccessPolicy.ssoOnlyConfirm.title')}
      message={scope === 'partner' ? t('portalAccessPolicy.ssoOnlyConfirm.partnerIntro') : t('portalAccessPolicy.ssoOnlyConfirm.intro')}
      confirmLabel={t('portalAccessPolicy.ssoOnlyConfirm.confirm')}
      variant="warning"
      isLoading={busy}
      confirmTestId="sso-only-confirm"
      dialogTestId="sso-only-confirm-dialog"
    >
      <div className="mt-3 space-y-3 text-sm">
        {changed && (
          <p role="status" data-testid="sso-only-confirm-changed" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {t('portalAccessPolicy.ssoOnlyConfirm.changed')}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t('portalAccessPolicy.ssoOnlyConfirm.explain')}</p>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1 font-medium">{t('portalAccessPolicy.ssoOnlyConfirm.columns.org')}</th>
              <th className="py-1 text-right font-medium">{t('portalAccessPolicy.ssoOnlyConfirm.columns.passwordsToClear')}</th>
              <th className="py-1 text-right font-medium">{t('portalAccessPolicy.ssoOnlyConfirm.columns.strandedTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {flips.map((f) => (
              <tr key={f.orgId} data-testid={`sso-only-confirm-flip-${f.orgId}`} className="border-b last:border-0">
                <td className="py-1">
                  {scope === 'partner' ? (
                    <a href={`/settings/organizations/${f.orgId}#portal`} className="text-primary hover:underline">{f.orgName}</a>
                  ) : f.orgName}
                </td>
                <td className="py-1 text-right tabular-nums">{f.passwordsToClear}</td>
                <td className="py-1 text-right tabular-nums">{f.strandedTotal}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {scope === 'org' && strandedTotal > 0 && (
          <div>
            <p className="text-xs font-medium">{t('portalAccessPolicy.ssoOnlyConfirm.strandedTitle')}</p>
            {strandedLoadFailed ? (
              <p className="text-xs text-muted-foreground">{t('portalAccessPolicy.ssoOnlyConfirm.strandedLoadError')}</p>
            ) : shownNames.length > 0 && (
              <ul data-testid="sso-only-confirm-stranded" className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {shownNames.map((a) => (
                  <li key={a.portalUserId}>{a.name ? `${a.name} (${a.email})` : a.email}</li>
                ))}
                {moreNames > 0 && <li>{t('portalAccessPolicy.ssoOnlyConfirm.strandedMore', { count: moreNames })}</li>}
              </ul>
            )}
          </div>
        )}

        {showInvites && (
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              data-testid="sso-only-confirm-send-invites"
              checked={sendInvites}
              disabled={busy}
              onChange={(e) => setSendInvites(e.target.checked)}
              className="mt-0.5"
            />
            <span>{t('portalAccessPolicy.ssoOnlyConfirm.sendInvites')}</span>
          </label>
        )}
      </div>
    </ConfirmDialog>
  );
}
