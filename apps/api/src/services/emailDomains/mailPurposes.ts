/**
 * The mail-purpose registry (partner sending domains, spec §8.1/§8.2).
 *
 * Every outbound email declares WHAT IT IS; this one file decides who it is
 * FROM. That inversion is the point: the classification becomes a single
 * reviewable list instead of a `from:` argument scattered across 27 call
 * sites, platform purposes short-circuit before any lookup, and the purpose
 * doubles as the delivery-event tag in W06.
 *
 * Adding a purpose is a product decision, not a mechanical one. The rules
 * (spec §8.2):
 *   - Mail from Breeze to the PARTNER'S OWN STAFF stays on the platform
 *     sender. Account recovery must never depend on the partner's DNS, and
 *     staff mailboxes usually live on the very domain being sent from.
 *   - Customer-facing mail goes on a partner stream.
 *   - Agent-deployment invites stay on the platform sender: they carry
 *     installer links to arbitrary typed addresses, which is exactly the
 *     shape hosted abuse takes, so the recipient must see Breeze's name and
 *     abuse contact.
 *
 * This module imports nothing. It must stay free of the db, config and
 * transport layers so a platform purpose can be resolved with no I/O.
 */

export type PartnerMailStream = 'support' | 'billing' | 'general';

export type MailPurposePolicy =
  | { lane: 'platform' }
  | {
      lane: 'partner';
      stream: PartnerMailStream;
      /**
       * The From used when no partner identity applies — which in W01 is
       * ALWAYS. It preserves what each send site does TODAY:
       *   'default'              → the bare EMAIL_FROM.
       *   'partner_display_name' → `"<Partner> via Breeze" <EMAIL_FROM address>`.
       * Only quote.sent and invoice.sent, the two sites that do this now.
       */
      fallbackFrom: 'default' | 'partner_display_name';
    };

export const MAIL_PURPOSES = {
  // ---- platform lane: auth and account recovery ---------------------------
  'auth.password_reset': { lane: 'platform' },
  'auth.email_verification': { lane: 'platform' },
  'auth.email_change_verify': { lane: 'platform' },
  'auth.email_changed': { lane: 'platform' },
  'auth.signup_existing_account': { lane: 'platform' },
  'auth.staff_invite': { lane: 'platform' },
  'auth.account_locked': { lane: 'platform' },
  'security.mfa_enrollment': { lane: 'platform' },
  'account.deletion_requested': { lane: 'platform' },
  'account.deletion_declined': { lane: 'platform' },
  'account.purge_warning': { lane: 'platform' },

  // ---- platform lane: operations and MSP staff notices --------------------
  'ops.alert': { lane: 'platform' },
  'staff.ai_budget_alert': { lane: 'platform' },
  'staff.contract_renewal': { lane: 'platform' },
  'staff.quote_outcome': { lane: 'platform' },
  // W03. The notice that a partner's own sending domain is verified / at risk
  // / failed / suspended / auto-removed. PLATFORM on purpose: a mail saying
  // "your sending domain is broken" must never be sent from that domain
  // (spec §6.3). Its send site is services/emailDomains/statusMail.ts.
  'staff.sending_domain_status': { lane: 'platform' },
  'staff.alert_notification': { lane: 'platform' },
  'staff.workspace_drift_report': { lane: 'platform' },
  'staff.report_failure': { lane: 'platform' },
  'deployment.invite': { lane: 'platform' },
  'ticket.staff_notification': { lane: 'platform' },

  // ---- partner lane -------------------------------------------------------
  'ticket.customer_notification': { lane: 'partner', stream: 'support', fallbackFrom: 'default' },
  'portal.invite': { lane: 'partner', stream: 'support', fallbackFrom: 'default' },
  'portal.password_reset': { lane: 'partner', stream: 'support', fallbackFrom: 'default' },
  'quote.sent': { lane: 'partner', stream: 'billing', fallbackFrom: 'partner_display_name' },
  'invoice.sent': { lane: 'partner', stream: 'billing', fallbackFrom: 'partner_display_name' },
  'report.delivery': { lane: 'partner', stream: 'general', fallbackFrom: 'default' },
} as const satisfies Record<string, MailPurposePolicy>;

export type MailPurpose = keyof typeof MAIL_PURPOSES;

/** The purposes whose registry entry is a partner-lane policy. */
export type PartnerLaneMailPurpose = {
  [K in MailPurpose]: (typeof MAIL_PURPOSES)[K] extends { lane: 'partner' } ? K : never;
}[MailPurpose];

export type PlatformMailPurpose = Exclude<MailPurpose, PartnerLaneMailPurpose>;

export function mailPurposePolicy(purpose: MailPurpose): MailPurposePolicy {
  // The `MailPurpose` parameter type is what makes an unclassified send a
  // compile error (G5) — but TypeScript is erased at runtime, so a caller that
  // bypasses the type (an `any`, a stale build, a deliberate `@ts-expect-error`
  // in a test) can still reach this with an unrecognized value. Fail open to
  // the platform lane rather than throwing and taking outbound mail down.
  return MAIL_PURPOSES[purpose] ?? { lane: 'platform' };
}
