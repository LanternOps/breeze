import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LINK } from '../ui';

/**
 * Frame for the public (emailed-link) automatic-payment pages: the MSP's name or
 * logo, one linen sheet on the plaster desk, and a concierge foot that says who to
 * ask and who processes the money. PublicDocumentLayout owns <main>; this never
 * renders one.
 */
export function AutopayShell({ partnerName, logoUrl, supportEmail, children, testId, reserveIdentity = false, contactInCard = false }: {
  partnerName?: string | null; logoUrl?: string | null; supportEmail?: string | null;
  children: ReactNode; testId?: string;
  /** Keep the identity row's height while the MSP is still loading, so it doesn't push the card down when it arrives (V-19). */
  reserveIdentity?: boolean;
  /** The card already offers to email the MSP; say it once (V-20). */
  contactInCard?: boolean;
}) {
  const named = !!(logoUrl || partnerName);
  return (
    <div className="settle-in mx-auto w-full max-w-xl" data-testid={testId}>
      {(named || reserveIdentity) && (
        <div className="mb-5 flex min-h-10 items-center gap-3" data-testid={named ? 'autopay-identity' : undefined} aria-hidden={named ? undefined : true}>
          {logoUrl
            ? <img src={logoUrl} alt={partnerName ?? ''} className="max-h-10 w-auto max-w-[12rem] object-contain" />
            : partnerName ? <p className="break-words font-display text-lg font-semibold text-foreground">{partnerName}</p> : null}
        </div>
      )}
      <section className="rounded-xl border border-border bg-card p-5 sm:p-8">{children}</section>
      <div className="mt-6 space-y-1.5 text-center text-sm text-muted-foreground">
        {supportEmail && !contactInCard && (
          <p>
            Questions? Email {partnerName || 'us'} at{' '}
            {/* V-21: an address never breaks at its hyphen. */}
            <a href={`mailto:${supportEmail}`} className={cn(LINK, 'whitespace-nowrap')}>{supportEmail}</a>
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
