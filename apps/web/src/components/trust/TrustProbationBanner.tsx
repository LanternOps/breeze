import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Circle, ShieldAlert, X } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import {
  TRUST_DENIED_EVENT,
  type TrustDenial,
} from '@/lib/trustProbation';

interface TrustStatus {
  trustState: string;
  checklist: {
    ageOk: boolean;
    emailVerified: boolean;
    cardSettled: boolean | null;
  };
  reviewRequestedAt: string | null;
  meetingUrl: string | null;
}

const CHECKLIST_ITEMS: ReadonlyArray<{
  key: keyof TrustStatus['checklist'];
  label: string;
}> = [
  { key: 'ageOk', label: '24 hours since signup' },
  { key: 'emailVerified', label: 'Email verified' },
  { key: 'cardSettled', label: 'Card payment settled' },
];

const CAPABILITY_LABELS: Record<TrustDenial['capability'], string> = {
  remote_control: 'Remote control',
  device_execute: 'Script execution',
  installer_distribute: 'Installer distribution',
  agent_enroll: 'Agent enrollment',
};

export default function TrustProbationBanner() {
  const [denial, setDenial] = useState<TrustDenial | null>(null);
  const [status, setStatus] = useState<TrustStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [reviewRequested, setReviewRequested] = useState(false);
  const [requestingReview, setRequestingReview] = useState(false);
  const requestSequence = useRef(0);

  const loadTrustStatus = useCallback(async (detail: TrustDenial, sequence: number) => {
    try {
      const response = await fetchWithAuth('/partner/trust');
      if (!response.ok) return;
      const next = await response.json() as TrustStatus;
      if (requestSequence.current !== sequence) return;
      setStatus(next);
      setReviewRequested(detail.reviewRequested || next.reviewRequestedAt !== null);
    } catch {
      // The denial body still has enough information to offer review/call actions.
    }
  }, []);

  useEffect(() => {
    const handleTrustDenied = (event: Event) => {
      // Claims this denial so runAction knows not to also show a generic
      // error toast on top of the banner (see dispatchTrustDenied).
      event.preventDefault();
      const detail = (event as CustomEvent<TrustDenial>).detail;
      const sequence = ++requestSequence.current;
      setDenial(detail);
      setStatus(null);
      setDismissed(false);
      setReviewRequested(detail.reviewRequested);
      void loadTrustStatus(detail, sequence);
    };
    window.addEventListener(TRUST_DENIED_EVENT, handleTrustDenied);
    return () => {
      requestSequence.current += 1;
      window.removeEventListener(TRUST_DENIED_EVENT, handleTrustDenied);
    };
  }, [loadTrustStatus]);

  const requestReview = async () => {
    setRequestingReview(true);
    try {
      await runAction<{ requested: true }>({
        request: () => fetchWithAuth('/partner/trust/request-review', { method: 'POST' }),
        errorFallback: 'Unable to request a review',
        successMessage: 'Review requested',
      });
      setReviewRequested(true);
    } catch (error) {
      // The endpoint uses 429 to mean the review is already pending. Present
      // that as the same durable banner state instead of inviting retries.
      if (error instanceof ActionError && error.status === 429) {
        setReviewRequested(true);
      }
    } finally {
      setRequestingReview(false);
    }
  };

  if (!denial || dismissed) return null;

  const restricted = denial.error === 'TRUST_RESTRICTED' || status?.trustState === 'restricted';
  const meetingUrl = status?.meetingUrl ?? denial.meetingUrl;

  return (
    <div
      role="status"
      data-testid="trust-probation-banner"
      className="mb-4 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3"
    >
      <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-foreground">
          {restricted ? 'Account restricted' : 'Verification pending'}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {CAPABILITY_LABELS[denial.capability]} is temporarily unavailable.
        </p>
        <p className="mt-1 text-sm text-foreground">
          Remote control and script execution unlock after your first card payment settles (about 24 hours) or once we've reviewed your account.
        </p>
        {status && (
          <ul className="mt-3 grid gap-1 sm:grid-cols-2" aria-label="Verification checklist">
            {CHECKLIST_ITEMS.map(({ key, label }) => {
              const complete = status.checklist[key] === true;
              return (
                <li key={key} className="flex items-center gap-2 text-sm text-foreground">
                  {complete
                    ? <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                    : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  <span>{label}</span>
                  <span className="sr-only">{complete ? 'complete' : 'pending'}</span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void requestReview()}
            disabled={reviewRequested || requestingReview}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-default disabled:opacity-70"
          >
            {reviewRequested ? 'Review requested' : requestingReview ? 'Requesting…' : 'Request review'}
          </button>
          {meetingUrl && (
            <a
              href={meetingUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-foreground underline"
            >
              Book a call
            </a>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss verification notice"
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
