import { describe, expect, it } from 'vitest';
import type { SendingDomainDto, SendingDomainsCapabilityDto } from '@breeze/shared';
import {
  POLL_PENDING_MS,
  POLL_PROVISIONING_MS,
  PROVISIONING_SLOW_AFTER_MS,
  RETRY_WINDOW_MS,
  SUGGESTED_LOCAL_PARTS,
  failureCopySuffix,
  firstUnhealthyRecord,
  fromAddressFor,
  isInsideRetryWindow,
  isProvisioningSlow,
  isTabVisible,
  isTrustLock,
  lockedCopySuffix,
  pollIntervalMs,
  sendableDomains,
} from './domainView';

const CAPABILITY: SendingDomainsCapabilityDto = {
  supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3,
};

function domain(over: Partial<SendingDomainDto> = {}): SendingDomainDto {
  return {
    id: 'd-1', domain: 'mail.acme.test', provider: 'fake', status: 'verified', statusReason: null,
    dnsRecords: [], verifiedAt: null, lastCheckedAt: null, lastTestAt: null, lastTestStatus: null,
    lastTestError: null, lastSendError: null, lastSendErrorAt: null, providerManaged: true,
    createdAt: '2026-09-17T12:00:00.000Z', statusChangedAt: '2026-09-17T12:00:00.000Z',
    ...over,
  };
}

describe('isTabVisible', () => {
  it('hides the tab when the fetch found no capability at all (the route 404d)', () => {
    expect(isTabVisible(null)).toBe(false);
  });

  it('hides the tab when this instance has no provider configured', () => {
    expect(isTabVisible({ ...CAPABILITY, supported: false, provider: null })).toBe(false);
  });

  it('SHOWS the tab when a provider is configured but its key cannot manage domains', () => {
    // spec §5.1: the settings tab explains provider_key_send_only. Hiding the
    // tab here would leave the operator with nothing to read.
    expect(isTabVisible({
      ...CAPABILITY, supported: false, eligible: false, reason: 'provider_key_send_only',
    })).toBe(true);
  });

  it('shows the tab for an eligible partner', () => {
    expect(isTabVisible(CAPABILITY)).toBe(true);
  });
});

describe('lockedCopySuffix', () => {
  it.each([
    ['provider_key_send_only', 'lockedProviderKeySendOnly'],
    ['partner_inactive', 'lockedPartnerInactive'],
    ['not_allowlisted', 'lockedNotAllowlisted'],
    ['probation_default_deny', 'lockedProbation'],
    ['restricted', 'lockedRestricted'],
  ])('maps %s', (reason, suffix) => {
    expect(lockedCopySuffix({ ...CAPABILITY, eligible: false, reason })).toBe(suffix);
  });

  it('falls back to the probation copy for an unrecognised trust reason', () => {
    expect(lockedCopySuffix({ ...CAPABILITY, eligible: false, reason: 'something_new' })).toBe('lockedProbation');
  });

  it('falls back to the probation copy when the server sent no reason at all', () => {
    expect(lockedCopySuffix({ ...CAPABILITY, eligible: false })).toBe('lockedProbation');
  });
});

describe('isTrustLock', () => {
  it('is true only for the two trust-derived reasons, which the banner can explain', () => {
    expect(isTrustLock({ ...CAPABILITY, eligible: false, reason: 'probation_default_deny' })).toBe(true);
    expect(isTrustLock({ ...CAPABILITY, eligible: false, reason: 'restricted' })).toBe(true);
    expect(isTrustLock({ ...CAPABILITY, eligible: false, reason: 'not_allowlisted' })).toBe(false);
    expect(isTrustLock({ ...CAPABILITY, eligible: false, reason: 'provider_key_send_only' })).toBe(false);
    expect(isTrustLock(CAPABILITY)).toBe(false);
  });
});

describe('failureCopySuffix', () => {
  it.each([
    ['provider_conflict', 'failedProviderConflict'],
    ['quota_exhausted', 'failedQuotaExhausted'],
    ['dns_not_detected', 'failedDnsNotDetected'],
    ['dns_removed', 'failedDnsRemoved'],
    ['abuse_auto', 'failedUnknown'],
  ] as const)('maps %s', (reason, suffix) => {
    expect(failureCopySuffix(domain({ status: 'failed', statusReason: reason }))).toBe(suffix);
  });

  it('tells a static-mode rejection to ask the instance administrator', () => {
    expect(failureCopySuffix(domain({ provider: 'static', status: 'failed', statusReason: 'provider_rejected' })))
      .toBe('staticNotAllowed');
  });

  it('blames the provider when a DNS-mode domain is rejected', () => {
    expect(failureCopySuffix(domain({ provider: 'resend', status: 'failed', statusReason: 'provider_rejected' })))
      .toBe('failedProviderRejected');
  });

  it('falls back when the reason is missing', () => {
    expect(failureCopySuffix(domain({ status: 'failed', statusReason: null }))).toBe('failedUnknown');
  });
});

describe('firstUnhealthyRecord', () => {
  const dkim = { purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: 'resend._domainkey.mail.acme.test', value: 'x', status: 'verified' } as const;
  const spf = { purpose: 'spf', type: 'TXT', host: 'send', fqdn: 'send.mail.acme.test', value: 'v=spf1', status: 'failed' } as const;

  it('names the record the at-risk banner must mention', () => {
    expect(firstUnhealthyRecord(domain({ status: 'at_risk', dnsRecords: [dkim, spf] }))?.fqdn)
      .toBe('send.mail.acme.test');
  });

  it('returns null when everything is verified', () => {
    expect(firstUnhealthyRecord(domain({ dnsRecords: [dkim] }))).toBeNull();
  });

  it('returns null when there are no records at all (static mode)', () => {
    expect(firstUnhealthyRecord(domain({ provider: 'static', dnsRecords: [] }))).toBeNull();
  });
});

describe('sendableDomains', () => {
  it('offers only verified and at-risk domains as identity targets', () => {
    const list = [
      domain({ id: 'a', status: 'verified' }),
      domain({ id: 'b', status: 'at_risk' }),
      domain({ id: 'c', status: 'pending' }),
      domain({ id: 'd', status: 'suspended' }),
      domain({ id: 'e', status: 'removing' }),
    ];
    expect(sendableDomains(list).map((d) => d.id)).toEqual(['a', 'b']);
  });
});

describe('fromAddressFor', () => {
  it('composes the address from the local part and the domain row', () => {
    expect(fromAddressFor({ localPart: 'support', sendingDomainId: 'd-1' }, [domain()]))
      .toBe('support@mail.acme.test');
  });

  it('returns null when the identity points at a domain the response did not carry', () => {
    // The saved identity carries its own `fromAddress` from the API, but the
    // form previews the values being EDITED, which no server field can know.
    expect(fromAddressFor({ localPart: 'support', sendingDomainId: 'gone' }, [domain()])).toBeNull();
  });
});

describe('pollIntervalMs', () => {
  it('polls fast while a domain is provisioning', () => {
    expect(pollIntervalMs([domain({ status: 'provisioning' }), domain({ status: 'pending' })]))
      .toBe(POLL_PROVISIONING_MS);
  });

  it('polls slowly while a domain waits for DNS', () => {
    expect(pollIntervalMs([domain({ status: 'pending' })])).toBe(POLL_PENDING_MS);
  });

  it('polls slowly while a domain is being removed', () => {
    expect(pollIntervalMs([domain({ status: 'removing' })])).toBe(POLL_PENDING_MS);
  });

  it('polls slowly while a test send is in flight', () => {
    expect(pollIntervalMs([domain({ status: 'verified', lastTestStatus: 'pending' })])).toBe(POLL_PENDING_MS);
  });

  it('stops polling once everything has settled', () => {
    expect(pollIntervalMs([domain({ status: 'verified' }), domain({ status: 'failed' })])).toBeNull();
  });

  it('stops polling when there are no domains at all', () => {
    expect(pollIntervalMs([])).toBeNull();
  });
});

describe('isProvisioningSlow', () => {
  const created = Date.parse('2026-09-17T12:00:00.000Z');

  it('is quiet for the first two minutes', () => {
    expect(isProvisioningSlow(domain({ status: 'provisioning' }), created + PROVISIONING_SLOW_AFTER_MS - 1)).toBe(false);
  });

  it('warns after two minutes', () => {
    expect(isProvisioningSlow(domain({ status: 'provisioning' }), created + PROVISIONING_SLOW_AFTER_MS + 1)).toBe(true);
  });

  it('never warns for a domain that is not provisioning', () => {
    expect(isProvisioningSlow(domain({ status: 'pending' }), created + 10 * PROVISIONING_SLOW_AFTER_MS)).toBe(false);
  });
});

describe('isInsideRetryWindow', () => {
  const failedAt = Date.parse('2026-09-17T12:00:00.000Z');
  const failed = domain({ status: 'failed', statusReason: 'dns_not_detected', statusChangedAt: '2026-09-17T12:00:00.000Z' });

  it('offers a retry while the failed row still holds its DNS records', () => {
    expect(isInsideRetryWindow(failed, failedAt + RETRY_WINDOW_MS - 60_000)).toBe(true);
  });

  it('stops offering a retry once the 72-hour window has passed', () => {
    // The worker auto-removes a failed row 72 h after it failed, so a retry
    // past that point can only race the removal.
    expect(isInsideRetryWindow(failed, failedAt + RETRY_WINDOW_MS + 60_000)).toBe(false);
  });

  it('is false for any status other than failed', () => {
    expect(isInsideRetryWindow(domain({ status: 'pending' }), failedAt + 1_000)).toBe(false);
  });

  it('errs toward offering the retry when the timestamp is unreadable', () => {
    expect(isInsideRetryWindow({ ...failed, statusChangedAt: 'not-a-date' }, failedAt)).toBe(true);
  });
});

describe('SUGGESTED_LOCAL_PARTS', () => {
  it('matches the spec §3.2 stream table', () => {
    expect(SUGGESTED_LOCAL_PARTS).toEqual({ support: 'support', billing: 'billing', general: 'notifications' });
  });
});
