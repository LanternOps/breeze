import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/shared/Dialog';
import { formatDate } from '@/lib/dateTimeFormat';
import { ActionError, handleActionError, runAction } from '@/lib/runAction';
import { publishTrustPage, type TrustPageDraft } from '@/lib/api/trustPage';
import type { OrgFetch } from '@/components/organizations/record/orgRecordFetch';

interface Props {
  open: boolean;
  onClose: () => void;
  orgId: string;
  orgFetch: OrgFetch;
  page: TrustPageDraft;
  onPublished: (page: TrustPageDraft) => void;
  /** Re-read the page (fresh publicationRevision) after a 409 REVISION_MISMATCH. */
  onStale: () => Promise<void>;
}

/**
 * Publish confirmation. A CUSTOMER page needs a recorded attestation that the
 * customer authorized publication; once recorded it is shown and reused (with a
 * Change link). The partner's own page needs none.
 */
export default function TrustPublishDialog({ open, onClose, orgId, orgFetch, page, onPublished, onStale }: Props) {
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.trust.${key}`, vars ?? {}),
    [t],
  );
  const recorded = !page.isPartnerHome && !!page.publicationAuthorizedBy;
  const [changing, setChanging] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [authorizedBy, setAuthorizedBy] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setChanging(false); setAuthorized(false); setAuthorizedBy(''); }
  }, [open]);

  const needsAttestation = !page.isPartnerHome && (!recorded || changing);
  const name = authorizedBy.trim();
  const canConfirm = !busy && (!needsAttestation || (authorized && name.length > 0));

  const submit = async () => {
    const body: { expectedRevision: number; authorization?: { authorizedBy: string } } = {
      expectedRevision: page.publicationRevision,
    };
    if (needsAttestation) body.authorization = { authorizedBy: name };
    setBusy(true);
    try {
      const data = await runAction({
        request: () => publishTrustPage(orgFetch, orgId, body),
        parseSuccess: (d) => (d as { data: { page: TrustPageDraft; snapshotId: string } }).data,
        successMessage: tr('publish.success'),
        errorFallback: tr('publish.failed'),
        friendly: (code, message) => ({
          REVISION_MISMATCH: tr('errors.revisionMismatch'),
          AUTHORIZATION_REQUIRED: tr('errors.authorizationRequired'),
          MFA_REQUIRED: tr('errors.mfaRequired'),
          TRUST_PROBATION: tr('errors.trustProbation'),
          TRUST_RESTRICTED: tr('errors.trustRestricted'),
          SLUG_INVALID: message || tr('errors.slugInvalid'),
          INTRO_TOO_LONG: tr('errors.introTooLong'),
        } as Record<string, string>)[code],
      });
      onPublished(data.page);
      onClose();
    } catch (err) {
      handleActionError(err, tr('publish.failed'));
      if (err instanceof ActionError && err.code === 'REVISION_MISMATCH') {
        // Retrying with the same stale revision would 409 forever: refresh the
        // page state, then close so the next attempt carries the new revision.
        try { await onStale(); } catch (reloadErr) { console.error('[TrustPublishDialog] reload after stale revision failed', reloadErr); }
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? () => undefined : onClose} title={tr('publish.title')} maxWidth="md">
      <div className="space-y-4 p-6" data-testid="trust-publish-dialog">
        <p className="text-sm text-muted-foreground">
          {tr('publish.intro', { indexable: page.searchIndexable ? tr('publish.indexableSuffix') : '' })}
        </p>
        {page.isPartnerHome && <p className="text-sm">{tr('publish.partnerHomeNote')}</p>}
        {recorded && !changing && (
          <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 p-3 text-sm" data-testid="trust-publish-recorded">
            <span>
              {tr('publish.recorded', {
                name: page.publicationAuthorizedBy,
                date: page.publicationAuthorizedAt ? formatDate(page.publicationAuthorizedAt) : '',
              })}
            </span>
            <button
              type="button"
              className="text-primary underline"
              onClick={() => setChanging(true)}
              data-testid="trust-publish-change"
            >
              {tr('publish.change')}
            </button>
          </div>
        )}
        {needsAttestation && (
          <div className="space-y-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={authorized}
                onChange={(e) => setAuthorized(e.target.checked)}
                data-testid="trust-publish-authorized-checkbox"
              />
              <span>{tr('publish.attestationCheckbox')}</span>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">{tr('publish.authorizedBy')}</span>
              <input
                type="text"
                value={authorizedBy}
                maxLength={200}
                placeholder={tr('publish.authorizedByPlaceholder')}
                onChange={(e) => setAuthorizedBy(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                data-testid="trust-publish-authorized-by"
              />
            </label>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            data-testid="trust-publish-cancel"
          >
            {tr('publish.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canConfirm}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            data-testid="trust-publish-confirm"
          >
            {busy ? tr('publish.publishing') : tr('publish.confirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
