import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import StatusPill from '@/components/billing/shared/StatusPill';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { showToast } from '@/components/shared/Toast';
import type { OrgFetch } from '@/components/organizations/record/orgRecordFetch';
import {
  createPreviewToken,
  setPartnerHome,
  trustPublicUrl,
  unpublishTrustPage,
  type TrustPageDraft,
  type TrustPageState,
} from '@/lib/api/trustPage';
import { useJwtClaims } from '@/lib/authScope';
import { formatDate } from '@/lib/dateTimeFormat';
import { ActionError, handleActionError, runAction } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import TrustPublishDialog from './TrustPublishDialog';
import { publicationPillRole } from './trustCenterPill';

interface Props {
  orgId: string;
  orgFetch: OrgFetch;
  state: TrustPageState;
  canWrite: boolean;
  /** Replace the draft after a mutation that returned the new page. */
  onPageChange: (page: TrustPageDraft) => void;
  /** Re-read the whole state (for mutations whose response is not the page). */
  onReload: () => Promise<void>;
}

export default function TrustStatusCard({ orgId, orgFetch, state, canWrite, onPageChange, onReload }: Props) {
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.trust.${key}`, vars ?? {}),
    [t],
  );
  const claims = useJwtClaims();
  const partnerScoped =
    claims.status === 'resolved' && (claims.claims.scope === 'partner' || claims.claims.scope === 'system');
  const [partnerHomeAllowed, setPartnerHomeAllowed] = useState(true);
  const [publishOpen, setPublishOpen] = useState(false);
  const [unpublishOpen, setUnpublishOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const { page, slugs, canPublish } = state;
  const published = page.publishedAt !== null;
  const url = trustPublicUrl(state.publicPath);
  const gateOk = slugs.valid && canPublish.allowed;
  const publishDisabled = !canWrite || !gateOk;
  const publishHint = !canWrite
    ? tr('publish.disabledNoWrite')
    : !slugs.valid
      ? tr('publish.disabledSlug')
      : canPublish.reason ?? undefined;

  const openPublish = () => {
    if (!canWrite) return;
    setPublishOpen(true);
  };
  const openUnpublish = () => {
    if (!canWrite) return;
    setUnpublishOpen(true);
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(url);
      showToast({ type: 'success', message: tr('status.copied') });
    } catch (err) {
      console.error('[TrustStatusCard] clipboard write failed', err);
      showToast({ type: 'error', message: tr('status.copyFailed') });
    }
  };

  const preview = async () => {
    if (!canWrite) return;
    // Open the window synchronously (inside the click) so the popup blocker
    // allows it; point it at the preview once the token is minted.
    const win = window.open('about:blank', '_blank');
    if (win) win.opener = null;
    setBusy(true);
    try {
      const data = await runAction({
        request: () => createPreviewToken(orgFetch, orgId),
        parseSuccess: (d) => (d as { data: { token: string; previewPath: string } }).data,
        errorFallback: tr('preview.failed'),
      });
      // previewPath is relative to the PORTAL base.
      const target = `${window.location.origin}/portal${data.previewPath}`;
      if (win) win.location.href = target;
      else showToast({ type: 'error', message: tr('preview.popupBlocked') });
    } catch (err) {
      win?.close();
      handleActionError(err, tr('preview.failed'));
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async () => {
    if (!canWrite) return;
    setBusy(true);
    try {
      const data = await runAction({
        request: () => unpublishTrustPage(orgFetch, orgId),
        parseSuccess: (d) => (d as { data: { page: TrustPageDraft } }).data,
        successMessage: tr('unpublish.success'),
        errorFallback: tr('unpublish.failed'),
        friendly: (code) => ({
          MFA_REQUIRED: tr('errors.mfaRequired'),
          TRUST_PROBATION: tr('errors.trustProbation'),
          TRUST_RESTRICTED: tr('errors.trustRestricted'),
        } as Record<string, string>)[code],
      });
      onPageChange(data.page);
      setUnpublishOpen(false);
    } catch (err) {
      handleActionError(err, tr('unpublish.failed'));
    } finally {
      setBusy(false);
    }
  };

  const togglePartnerHome = async () => {
    if (!canWrite) return;
    setBusy(true);
    try {
      await runAction({
        request: () => setPartnerHome(orgFetch, orgId, !page.isPartnerHome),
        successMessage: tr('partnerHome.success'),
        errorFallback: tr('partnerHome.failed'),
        friendly: (code) => ({
          MFA_REQUIRED: tr('errors.mfaRequired'),
          PARTNER_WIDE_REQUIRED: tr('errors.partnerWideRequired'),
        } as Record<string, string>)[code],
      });
      onReload();
    } catch (err) {
      // Not a partner-wide admin: the switch can never work for this user.
      if (err instanceof ActionError && err.code === 'PARTNER_WIDE_REQUIRED') setPartnerHomeAllowed(false);
      handleActionError(err, tr('partnerHome.failed'));
    } finally {
      setBusy(false);
    }
  };

  const slugProblems = slugs.problems.map((p) =>
    p === 'partner_slug' || p === 'org_slug' ? tr(`slug.${p}`) : tr('slug.unknown', { problem: p }),
  );

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" data-testid="trust-status-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{tr('title')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{tr('subtitle')}</p>
        </div>
        <StatusPill
          role={publicationPillRole(page.publishedAt)}
          label={published ? tr('status.published', { date: formatDate(page.publishedAt as string) }) : tr('status.unpublished')}
          testId="trust-status-pill"
        />
      </div>

      <div className="text-sm">
        <div className="text-xs font-medium text-muted-foreground">{tr('status.publicUrl')}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="break-all rounded bg-muted px-2 py-1 text-xs" data-testid="trust-public-url">{url}</code>
          <button type="button" onClick={() => void copyUrl()} className="rounded-md border px-2 py-1 text-xs hover:bg-muted" data-testid="trust-copy-url">
            {tr('status.copy')}
          </button>
        </div>
        {page.lastEvaluatedAt && (
          <p className="mt-2 text-xs text-muted-foreground">{tr('status.lastEvaluated', { date: formatDate(page.lastEvaluatedAt) })}</p>
        )}
      </div>

      {!slugs.valid && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" role="alert" data-testid="trust-slug-warning">
          <div className="font-medium">{tr('slug.warningTitle')}</div>
          <ul className="mt-1 list-disc pl-5">
            {slugProblems.map((msg) => <li key={msg}>{msg}</li>)}
          </ul>
          <button
            type="button"
            className="mt-2 text-primary underline"
            onClick={() => void navigateTo(`/settings/organizations/${orgId}`)}
            data-testid="trust-slug-settings-link"
          >
            {tr('slug.openSettings')}
          </button>
        </div>
      )}

      {!canPublish.allowed && canPublish.reason && (
        <p className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="trust-gate-notice">
          {tr('notice.cannotPublish', { reason: canPublish.reason })}
        </p>
      )}
      {!canWrite && <p className="text-xs text-muted-foreground">{tr('notice.readOnly')}</p>}

      {partnerScoped && partnerHomeAllowed && (
        <div className="flex items-start justify-between gap-3 rounded-md border p-3">
          <div id="trust-partner-home-label" className="text-sm">
            <div className="font-medium">{tr('partnerHome.label')}</div>
            <div className="text-xs text-muted-foreground">{tr('partnerHome.description')}</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={page.isPartnerHome}
            aria-labelledby="trust-partner-home-label"
            disabled={!canWrite || busy}
            onClick={() => void togglePartnerHome()}
            data-testid="trust-partner-home-switch"
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-50 ${page.isPartnerHome ? 'bg-emerald-500/80' : 'bg-muted'}`}
          >
            <span
              aria-hidden="true"
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${page.isPartnerHome ? 'translate-x-6' : 'translate-x-1'}`}
            />
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={publishDisabled || busy}
          title={publishHint}
          onClick={openPublish}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="trust-publish"
        >
          {published ? tr('publish.republish') : tr('publish.button')}
        </button>
        {published && (
          <button
            type="button"
            disabled={!canWrite || busy}
            onClick={openUnpublish}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="trust-unpublish"
          >
            {tr('unpublish.button')}
          </button>
        )}
        <button
          type="button"
          disabled={!canWrite || busy}
          onClick={() => void preview()}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="trust-preview"
        >
          {tr('preview.button')}
        </button>
      </div>

      <TrustPublishDialog
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        orgId={orgId}
        orgFetch={orgFetch}
        page={page}
        onPublished={onPageChange}
        onStale={onReload}
      />
      <ConfirmDialog
        open={unpublishOpen}
        onClose={() => setUnpublishOpen(false)}
        onConfirm={() => void unpublish()}
        title={tr('unpublish.title')}
        message={tr('unpublish.message')}
        confirmLabel={tr('unpublish.confirm')}
        variant="warning"
        isLoading={busy}
        confirmTestId="trust-unpublish-confirm"
      />
    </section>
  );
}
