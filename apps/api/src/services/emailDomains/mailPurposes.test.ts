import { describe, expect, it } from 'vitest';
import {
  MAIL_PURPOSES,
  mailPurposePolicy,
  type MailPurpose,
  type PartnerMailStream,
} from './mailPurposes';

const ALL_PURPOSES = Object.keys(MAIL_PURPOSES) as MailPurpose[];
const STREAMS: PartnerMailStream[] = ['support', 'billing', 'general'];

describe('MAIL_PURPOSES registry (spec §8.1, §8.2)', () => {
  it('classifies every purpose into exactly one well-formed lane', () => {
    expect(ALL_PURPOSES.length).toBeGreaterThan(0);
    for (const purpose of ALL_PURPOSES) {
      const policy = mailPurposePolicy(purpose);
      if (policy.lane === 'platform') {
        expect(Object.keys(policy)).toEqual(['lane']);
        continue;
      }
      expect(policy.lane).toBe('partner');
      expect(STREAMS).toContain(policy.stream);
      expect(['default', 'partner_display_name']).toContain(policy.fallbackFrom);
    }
  });

  it('mailPurposePolicy returns the registry entry itself, not a copy', () => {
    for (const purpose of ALL_PURPOSES) {
      expect(mailPurposePolicy(purpose)).toBe(MAIL_PURPOSES[purpose]);
    }
  });

  // Spec §8.2 is normative. Pinning the exact classification here makes the
  // review artefact (the table) a test, not a comment: a later wave that wants
  // to move mail onto a partner's domain has to edit this list on purpose.
  it('pins the §8.2 classification of every purpose', () => {
    expect(MAIL_PURPOSES).toEqual({
      'auth.password_reset': { lane: 'platform' },
      'auth.email_verification': { lane: 'platform' },
      'auth.email_change_verify': { lane: 'platform' },
      'auth.email_changed': { lane: 'platform' },
      'auth.signup_existing_account': { lane: 'platform' },
      'auth.staff_invite': { lane: 'platform' },
      'auth.account_locked': { lane: 'platform' },
      'security.mfa_enrollment': { lane: 'platform' },
      'security.caller_rejection': { lane: 'platform' },
      'account.deletion_requested': { lane: 'platform' },
      'account.deletion_declined': { lane: 'platform' },
      'account.purge_warning': { lane: 'platform' },
      'ops.alert': { lane: 'platform' },
      'staff.ai_budget_alert': { lane: 'platform' },
      'staff.contract_renewal': { lane: 'platform' },
      'staff.quote_outcome': { lane: 'platform' },
      'staff.sending_domain_status': { lane: 'platform' },
      'staff.alert_notification': { lane: 'platform' },
      'staff.workspace_drift_report': { lane: 'platform' },
      'staff.report_failure': { lane: 'platform' },
      'deployment.invite': { lane: 'platform' },
      'ticket.staff_notification': { lane: 'platform' },
      'ticket.customer_notification': { lane: 'partner', stream: 'support', fallbackFrom: 'default' },
      'portal.invite': { lane: 'partner', stream: 'support', fallbackFrom: 'default' },
      'portal.password_reset': { lane: 'partner', stream: 'support', fallbackFrom: 'default' },
      'quote.sent': { lane: 'partner', stream: 'billing', fallbackFrom: 'partner_display_name' },
      'invoice.sent': { lane: 'partner', stream: 'billing', fallbackFrom: 'partner_display_name' },
      'report.delivery': { lane: 'partner', stream: 'general', fallbackFrom: 'default' },
    });
  });

  // Spec §8.3: the display-name From is what quote and invoice sends produce
  // TODAY, and nothing else. Extending it to more purposes is a separate
  // product change, so it must not happen by accident in a later wave.
  it('uses the partner_display_name fallback only for quote.sent and invoice.sent', () => {
    const branded = ALL_PURPOSES.filter((p) => {
      const policy = mailPurposePolicy(p);
      return policy.lane === 'partner' && policy.fallbackFrom === 'partner_display_name';
    });
    expect(branded.sort()).toEqual(['invoice.sent', 'quote.sent']);
  });

  // Index amendment 5: the test send bypasses sendEmail entirely, so its
  // `sending_domain.test` tag is NOT a mail purpose and must never appear here
  // — an entry with no send site fails the "no dead entries" scan
  // (mailPurposes.callSites.test.ts). `staff.sending_domain_status` was the
  // other half of this guard until W03, which added it together with its send
  // site, services/emailDomains/statusMail.ts.
  it('does not carry tag-only purposes', () => {
    expect(ALL_PURPOSES).not.toContain('sending_domain.test');
  });

  // A purpose outside the registry can only reach mailPurposePolicy by
  // bypassing TypeScript (G5 is compile-time only). Fail open to the
  // platform lane rather than throwing — resolveSender (senderResolution.ts)
  // is responsible for logging when this happens; this module stays
  // dependency-free and pure.
  it('falls back to the platform lane for a purpose not in the registry', () => {
    expect(mailPurposePolicy('nope' as never)).toEqual({ lane: 'platform' });
  });
});
