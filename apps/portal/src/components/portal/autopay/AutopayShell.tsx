import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { LINK } from '../ui';

/**
 * Frame for the public (emailed-link) automatic-payment pages: the MSP's name or
 * logo, one linen sheet on the plaster desk, and a concierge foot that says who to
 * ask and who processes the money. PublicDocumentLayout owns <main>; this never
 * renders one.
 */
export function AutopayShell({ partnerName, logoUrl, supportEmail, children, testId }: {
  partnerName?: string | null; logoUrl?: string | null; supportEmail?: string | null;
  children: ReactNode; testId?: string;
}) {
  return (
    <div className="settle-in mx-auto w-full max-w-xl" data-testid={testId}>
      {(logoUrl || partnerName) && (
        <div className="mb-5 flex min-h-10 items-center gap-3" data-testid="autopay-identity">
          {logoUrl
            ? <img src={logoUrl} alt={partnerName ?? ''} className="max-h-10 w-auto max-w-[12rem] object-contain" />
            : <p className="break-words font-display text-lg font-semibold text-foreground">{partnerName}</p>}
        </div>
      )}
      <section className="rounded-xl border border-border bg-card p-5 sm:p-8">{children}</section>
      <div className="mt-6 space-y-1.5 text-center text-sm text-muted-foreground">
        {supportEmail && (
          <p>
            Questions? Email {partnerName || 'us'} at{' '}
            <a href={`mailto:${supportEmail}`} className={LINK}>{supportEmail}</a>
          </p>
        )}
        <p className="inline-flex items-center justify-center gap-1.5">
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
          Payments are processed securely by Stripe.
        </p>
      </div>
    </div>
  );
}

export default AutopayShell;
