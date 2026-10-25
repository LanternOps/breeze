import { useEffect, useMemo, useState } from 'react';
import { DocumentAgreementBody, DocumentHeader, DocumentPaper } from '@breeze/document-ui';
import type { AgreementBody, DocumentBranding, DocumentHeaderModel, SanitizedHtml } from '@breeze/shared/documents';
import { portalApi, publicAgreementFilePath, type PublicAgreementDetail } from '@/lib/api';
import { cn } from '@/lib/utils';
import { portalAgreementHostComponents } from './documentHostComponents';
import { SignaturePanel } from './SignaturePanel';

type Status = PublicAgreementDetail['request']['status'];

interface PublicAgreementViewProps {
  token: string;
  /** Test seam only: the page never passes this (it fetches client-side so the signer's IP keys the rate bucket). */
  initial?: PublicAgreementDetail | null;
}

type Gone = { code: string | undefined; partnerName: string | null };

const GENERIC_INVALID = 'This agreement link is invalid or has expired.';

function dateOf(value: string): { text: string; iso: string } {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return { text: value, iso: value };
  return {
    text: d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', ...(dateOnly ? { timeZone: 'UTC' } : {}) }),
    iso: dateOnly ? value : d.toISOString(),
  };
}

function statusChip(status: Status): NonNullable<DocumentHeaderModel['status']> {
  switch (status) {
    case 'signed': return { label: 'Signed', tone: 'success' };
    case 'declined': return { label: 'Declined', tone: 'danger' };
    default: return { label: 'Awaiting signature', tone: 'info' };
  }
}

function goneMessage(gone: Gone): string {
  if (gone.code === 'LINK_REVOKED') {
    return `This agreement request was withdrawn${gone.partnerName ? ` — please contact ${gone.partnerName}` : ''}.`;
  }
  if (gone.code === 'AGREEMENT_EXPIRED') return 'This agreement request has expired.';
  return 'This link is no longer available.';
}

export function PublicAgreementView({ token, initial = null }: PublicAgreementViewProps) {
  const [detail, setDetail] = useState<PublicAgreementDetail | null>(initial);
  const [loading, setLoading] = useState(initial == null);
  const [invalid, setInvalid] = useState(false);
  const [gone, setGone] = useState<Gone | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | ''>(initial?.request.status ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [signedEmail, setSignedEmail] = useState<string | null>(null);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    void portalApi.getPublicAgreement(token, { redirectOnUnauthorized: false }).then((res) => {
      if (cancelled) return;
      if (res.data?.data) {
        setDetail(res.data.data);
        setStatus(res.data.data.request.status);
      } else if (res.statusCode === 401) {
        setInvalid(true);
      } else if (res.statusCode === 410) {
        const branding = (res.errorData as { branding?: { partnerName?: string } } | undefined)?.branding;
        setGone({ code: res.code, partnerName: branding?.partnerName ?? null });
      } else {
        setLoadError(res.error ?? GENERIC_INVALID);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [token, initial]);

  const view = useMemo(() => {
    if (!detail) return null;
    const { request, template, branding, parties } = detail;
    const live: Status = status || request.status;
    const signed = live === 'signed';
    const dates: DocumentHeaderModel['dates'] = [];
    if (request.effectiveDate) dates.push({ label: 'Effective', value: dateOf(request.effectiveDate) });
    if (signed && request.signedAt) dates.push({ label: 'Signed', value: dateOf(request.signedAt) });
    else if (!signed && live !== 'declined') dates.push({ label: 'Expires', value: dateOf(request.expiresAt) });
    const header: DocumentHeaderModel = {
      eyebrow: 'Agreement',
      number: template.name,
      subtitle: `Agreement from ${parties.partnerName}${parties.orgName ? ` for ${parties.orgName}` : ''}`,
      status: statusChip(live),
      dates,
      billTo: null,
    };
    const docBranding: DocumentBranding = {
      logo: branding.logoUrl ? { kind: 'url', url: branding.logoUrl } : null,
      logoAlt: branding.partnerName,
      wordmark: branding.partnerName,
      theme: 'classic',
      pageSize: 'letter',
      seller: branding.seller,
    };
    const footer = `${template.name} · v${template.versionNumber}`;
    const unavailableText = 'This agreement is not available to view.';
    const body: AgreementBody = template.sourceType === 'uploaded'
      ? {
          kind: 'uploaded',
          file: detail.fileUrl ? { kind: 'agreement_file', id: request.id } : null,
          fileTitle: template.name,
          downloadLabel: 'Download agreement',
          footer,
          unavailableText,
        }
      : { kind: 'authored', html: (detail.html as SanitizedHtml | null), footer, unavailableText };
    return { header, docBranding, body, components: portalAgreementHostComponents(publicAgreementFilePath(token)) };
  }, [detail, status, token]);

  if (loading) {
    return (
      <div data-testid="public-agreement-loading" className="mx-auto max-w-lg p-8 text-center text-sm text-muted-foreground">
        Loading agreement…
      </div>
    );
  }

  if (gone) {
    return (
      <div data-testid="public-agreement-unavailable" role="status" className="mx-auto max-w-lg p-8 text-center">
        <p className="text-sm">{goneMessage(gone)}</p>
      </div>
    );
  }

  if (invalid || loadError || !detail || !view) {
    return (
      <div data-testid="public-agreement-error" role="alert" className="mx-auto max-w-lg p-8 text-center text-destructive">
        <p className="text-sm">{invalid || !loadError ? GENERIC_INVALID : loadError}</p>
      </div>
    );
  }

  const { request, parties } = detail;
  const live: Status = status || request.status;
  const open = live === 'sent' || live === 'viewed';

  const accept = async (signerName: string, signerEmail?: string) => {
    if (busy || !signerName.trim() || !signerEmail) return;
    setBusy(true);
    setMsg(null);
    const res = await portalApi.acceptPublicAgreement(token, signerName.trim(), signerEmail);
    setBusy(false);
    if (res.error) {
      setMsg(res.error);
      return;
    }
    setSignedEmail(signerEmail);
    setStatus('signed');
  };

  const decline = async (reason?: string) => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const res = await portalApi.declinePublicAgreement(token, reason);
    setBusy(false);
    if (res.error) {
      setMsg(res.error);
      return;
    }
    setStatus('declined');
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-2 sm:p-4">
      <DocumentPaper theme={view.docBranding.theme}>
        <DocumentHeader header={view.header} branding={view.docBranding} components={view.components} />
        <DocumentAgreementBody body={view.body} title={detail.template.name} components={view.components} />
        {open && (
          <div className="space-y-4">
            <SignaturePanel
              onAccept={(name, email) => void accept(name, email)}
              onDecline={(reason) => void decline(reason)}
              busy={busy}
              testIdPrefix="public-agreement"
              agreements={[]}
              acceptLabel="Sign agreement"
              heading="Sign this agreement"
              intro="By typing your full legal name and selecting Sign agreement, you electronically accept this agreement."
              requireSignerEmail
              documentNoun="agreement"
            />
            {msg && (
              <div role="alert" className={cn('rounded-md p-3 text-sm', 'bg-destructive/10 text-destructive-on-tint')}>
                {msg}
              </div>
            )}
          </div>
        )}
        {request.coverMessage && (
          <p data-testid="public-agreement-cover-message" className="whitespace-pre-line text-sm text-muted-foreground">
            {request.coverMessage}
          </p>
        )}
      </DocumentPaper>

      {live === 'signed' && (
        <div data-testid="public-agreement-signed" role="status" className="rounded-md bg-success/10 p-4 text-sm text-success-on-tint">
          {signedEmail
            ? `Signed. A copy will be emailed to ${signedEmail}.`
            : 'This agreement has been signed.'}
        </div>
      )}
      {live === 'declined' && (
        <div data-testid="public-agreement-declined" role="status" className="rounded-md bg-muted p-3 text-sm">
          Thanks — {parties.partnerName} has been notified.
        </div>
      )}
    </div>
  );
}

export default PublicAgreementView;
