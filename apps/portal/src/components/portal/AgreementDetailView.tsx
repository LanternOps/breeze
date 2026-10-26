import { useMemo, useState } from 'react';
import { AlertCircle, ArrowLeft, Download } from 'lucide-react';
import { DocumentAgreementBody, DocumentHeader, DocumentPaper } from '@breeze/document-ui';
import type { AgreementBody, DocumentBranding, DocumentHeaderModel, SanitizedHtml } from '@breeze/shared/documents';
import {
  portalAgreementFilePath,
  portalApi,
  signedAgreementFilePath,
  type ApiResponse,
  type PortalAgreementDetail,
} from '@/lib/api';
import { withBase } from '@/lib/basePath';
import { runAction } from '@/lib/runAction';
import { portalAgreementHostComponents } from './documentHostComponents';
import { SignaturePanel } from './SignaturePanel';
import { BTN_SECONDARY, Notice } from './ui';

type Status = PortalAgreementDetail['request']['status'];

interface AgreementDetailViewProps {
  detail?: PortalAgreementDetail | null;
  /** Alias of `detail` (test seam mirroring QuoteDetailView). */
  initial?: PortalAgreementDetail | null;
  error?: string | null;
  /** HTTP status of the failed load: 404 reads as "not found"; anything else is an outage. */
  statusCode?: number;
}

const UNAVAILABLE = 'This agreement is no longer available.';
const ACCEPT_FALLBACK = 'We could not record your signature. Please try again.';
const DECLINE_FALLBACK = 'We could not record your decision. Please try again.';

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

function BackLink() {
  return (
    <a
      href={withBase('/agreements')}
      data-testid="agreement-back"
      className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" />
      Back to agreements
    </a>
  );
}

export function AgreementDetailView({ detail: detailProp, initial, error, statusCode }: AgreementDetailViewProps) {
  const detail = detailProp ?? initial ?? null;
  const [status, setStatus] = useState<Status | ''>(detail?.request.status ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [justSigned, setJustSigned] = useState(false);
  const [signedAgreementId, setSignedAgreementId] = useState<string | null>(detail?.signedAgreementId ?? null);

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
    return {
      header,
      docBranding,
      body,
      components: portalAgreementHostComponents(portalAgreementFilePath(request.id), 'agreement'),
    };
  }, [detail, status]);

  if (error || !detail || !view) {
    const notFound = statusCode === 404 || !error;
    return (
      <div className="border-y border-border/70 py-14 text-center">
        <AlertCircle className="mx-auto h-10 w-10 text-destructive-on-tint" strokeWidth={1.5} />
        <div data-testid={notFound ? 'agreement-not-found' : 'agreement-load-error'}>
          <h3 className="mt-4 font-display text-lg font-semibold text-foreground">
            {notFound ? 'Agreement not found' : "We couldn't load this agreement"}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {notFound
              ? "We couldn't find that agreement — it may have been withdrawn or expired. Your agreements list is current."
              : 'Something went wrong on our side. Try again in a moment; your agreements list is unaffected.'}
          </p>
        </div>
        <div className="mt-4 flex justify-center">
          <BackLink />
        </div>
      </div>
    );
  }

  const { request, parties, canSign } = detail;
  const live: Status = status || request.status;
  const open = live === 'sent' || live === 'viewed';

  /** Run one portal call through runAction; returns the data, or null after setting the inline message. */
  const run = async <T,>(
    call: () => Promise<ApiResponse<T>>,
    errorFallback: string,
  ): Promise<T | null> => {
    setBusy(true);
    setMsg(null);
    let failure: ApiResponse<unknown> | null = null;
    const result = await runAction<T>({
      request: async () => {
        const response = await call();
        if (response.error || (response.statusCode ?? 200) >= 400) failure = response;
        return response;
      },
      // The outcome copy is chosen below, from the status code.
      onOutcome: () => {},
      successMessage: '',
      errorFallback,
    });
    setBusy(false);
    if (result) return result;
    const failed = failure as ApiResponse<unknown> | null;
    setMsg(failed?.statusCode === 404 ? UNAVAILABLE : failed?.error || errorFallback);
    return null;
  };

  const accept = async (signerName: string) => {
    if (busy || !signerName.trim()) return;
    const result = await run(() => portalApi.acceptAgreement(request.id, signerName.trim()), ACCEPT_FALLBACK);
    if (!result) return;
    setSignedAgreementId(result.data?.signedAgreementId ?? null);
    setJustSigned(true);
    setStatus('signed');
  };

  const decline = async (reason?: string) => {
    if (busy) return;
    const result = await run(() => portalApi.declineAgreement(request.id, reason), DECLINE_FALLBACK);
    if (!result) return;
    setStatus('declined');
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5" data-testid="agreement-detail">
      <BackLink />
      <DocumentPaper theme={view.docBranding.theme}>
        <DocumentHeader header={view.header} branding={view.docBranding} components={view.components} />
        <DocumentAgreementBody body={view.body} title={detail.template.name} components={view.components} />
        {open && canSign && (
          <SignaturePanel
            onAccept={(name) => void accept(name)}
            onDecline={(reason) => void decline(reason)}
            busy={busy}
            testIdPrefix="agreement"
            agreements={[]}
            acceptLabel="Sign agreement"
            heading="Sign this agreement"
            intro="By typing your full legal name and selecting Sign agreement, you electronically accept this agreement."
            documentNoun="agreement"
          />
        )}
        {request.coverMessage && (
          <p data-testid="agreement-cover-message" className="whitespace-pre-line text-sm text-muted-foreground">
            {request.coverMessage}
          </p>
        )}
      </DocumentPaper>

      {open && !canSign && (
        <Notice tone="neutral" data-testid="agreement-not-recipient">
          This agreement was sent to another contact at your organization. Only a named recipient can sign it.
        </Notice>
      )}

      {msg && (
        <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive-on-tint">
          {msg}
        </div>
      )}

      {live === 'signed' && (
        <div data-testid="agreement-signed" role="status" className="space-y-3 rounded-md bg-success/10 p-4 text-sm text-success-on-tint">
          <p>{justSigned ? 'Signed. A copy is on its way to your email.' : 'This agreement has been signed.'}</p>
          {signedAgreementId && (
            <div className="flex flex-wrap gap-2">
              <a
                href={signedAgreementFilePath(signedAgreementId, 'certified')}
                data-testid="agreement-download-certified"
                className={BTN_SECONDARY}
              >
                <Download className="h-4 w-4" />
                Download signed copy
              </a>
              <a
                href={signedAgreementFilePath(signedAgreementId, 'original')}
                data-testid="agreement-download-original"
                className={BTN_SECONDARY}
              >
                Original file
              </a>
            </div>
          )}
        </div>
      )}
      {live === 'declined' && (
        <div data-testid="agreement-declined" role="status" className="rounded-md bg-muted p-3 text-sm">
          You declined this agreement — {parties.partnerName} has been notified.
        </div>
      )}
    </div>
  );
}

export default AgreementDetailView;
