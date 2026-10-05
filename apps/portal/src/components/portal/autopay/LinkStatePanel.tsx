import type { AutopayLinkFailureCode, AutopayLinkFailureDetails, BillingLinkPurpose } from '@breeze/shared';

/** A link failure as the page sees it: the code plus the error body's `data`. */
export type LinkFailureView = { code: AutopayLinkFailureCode } & AutopayLinkFailureDetails;
import { withBase } from '@/lib/basePath';
import { StatePanel, type PanelAction } from './StatePanel';

const mailto = (email: string) => `mailto:${email}`;

/** Why an emailed autopay link can't be used, with the next step, instead of
 *  "Automatic payments not found" (lab D-3, D-16). An unknown link names no MSP. */
export function linkFailureCopy(failure: LinkFailureView, purpose: BillingLinkPurpose) {
  const msp = failure.partnerName || 'the company that sent it';
  const contact: PanelAction | null = failure.supportEmail
    ? { label: `Email ${failure.partnerName || 'them'}`, href: mailto(failure.supportEmail), testId: 'autopay-link-contact' } : null;
  switch (failure.code) {
    case 'link_expired':
      return { title: 'This link has expired', body: [`For your security, links from ${msp} stop working after a while. Ask ${msp} to send you a new one.`], primary: contact };
    case 'link_replaced':
      return { title: 'This link was replaced', body: [`${msp} sent you a newer link. Please use the one in your most recent email from ${msp}.`], primary: contact };
    case 'link_used':
      if (failure.enrollmentStatus === 'cancelled') {
        return { title: 'Automatic payments are off', mark: { tone: 'neutral' as const, label: 'Off' },
          body: [`${msp} won't charge you automatically.`, purpose === 'enroll' || purpose === 'stop_autopay'
            ? `To turn automatic payments back on, ask ${msp} to send you a new setup link.` : 'Please pay the invoice from its email.'],
          primary: contact };
      }
      if (purpose === 'enroll' && failure.enrollmentStatus === 'active') {
        return { title: "You're already set up", mark: { tone: 'success' as const, label: 'On' },
          body: [`Automatic payments to ${msp} are on. To change your payment method, sign in to your customer portal or use the link in your latest email from ${msp}.`],
          primary: { label: 'Sign in to your portal', href: withBase('/login'), variant: 'secondary' as const, testId: 'autopay-link-sign-in' } as PanelAction };
      }
      return { title: 'This link was already used', body: ['Open the invoice from your email to see its current status.'], primary: contact };
    // The skip route has no rollout gate (Q4), so a skip link never lands here; the
    // skip page says "on hold" itself from the view (V-37).
    case 'autopay_not_enabled':
      return { title: "Automatic payment setup isn't available right now",
          body: [`${msp} isn't taking new automatic payment setups at the moment. Your invoices can still be paid from the links in their emails.`], primary: contact };
    case 'link_invalid':
    default:
      return { title: "This link doesn't work", body: ['Check that you opened the whole link from your email. If it still doesn\'t work, ask the company that sent it for a new one.'], primary: null };
  }
}

/** V-20: when the panel's next step is emailing the MSP, the page footer doesn't repeat the address. */
export function linkFailureContactInCard(failure: LinkFailureView, purpose: BillingLinkPurpose): boolean {
  return linkFailureCopy(failure, purpose).primary?.testId === 'autopay-link-contact';
}

export function LinkStatePanel({ failure, purpose }: { failure: LinkFailureView; purpose: BillingLinkPurpose }) {
  const copy = linkFailureCopy(failure, purpose);
  return (
    <StatePanel title={copy.title} mark={'mark' in copy ? copy.mark : undefined} primary={copy.primary}
      testId={`autopay-link-${failure.code}`}>
      {copy.body.map(line => <p key={line}>{line}</p>)}
    </StatePanel>
  );
}

export default LinkStatePanel;
