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
          primary: { label: 'Sign in to your portal', href: withBase('/login'), variant: 'secondary' as const, testId: 'autopay-link-sign-in' } as PanelAction,
          secondary: contact };
      }
      return { title: 'This link was already used', body: ['Open the invoice from your email to see its current status.'], primary: contact };
    case 'autopay_not_enabled':
      return purpose === 'skip_invoice'
        ? { title: 'Automatic payments are on hold', mark: { tone: 'neutral' as const, label: 'On hold' },
          body: [`${msp} has put automatic payments on hold, so this link can't skip the payment right now. To be sure the invoice is paid the way you want, pay it yourself or email ${msp}.`], primary: contact }
        : { title: "Automatic payment setup isn't available right now",
          body: [`${msp} isn't taking new automatic payment setups at the moment. Your invoices can still be paid from the links in their emails.`], primary: contact };
    case 'link_invalid':
    default:
      return { title: "This link doesn't work", body: ['Check that you opened the whole link from your email. If it still doesn\'t work, ask the company that sent it for a new one.'], primary: null };
  }
}

export function LinkStatePanel({ failure, purpose }: { failure: LinkFailureView; purpose: BillingLinkPurpose }) {
  const copy = linkFailureCopy(failure, purpose);
  const secondary = 'secondary' in copy ? copy.secondary : null;
  return (
    <StatePanel title={copy.title} mark={'mark' in copy ? copy.mark : undefined} primary={copy.primary} secondary={secondary}
      testId={`autopay-link-${failure.code}`}>
      {copy.body.map(line => <p key={line}>{line}</p>)}
    </StatePanel>
  );
}

export default LinkStatePanel;
