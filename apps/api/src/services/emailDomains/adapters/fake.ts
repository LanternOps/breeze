import { getEmailService } from '../../email';
import {
  PartnerLaneSendFailure,
  ProviderDomainConflictError,
  type CreateProviderDomainInput,
  type EmailDomainProvider,
  type PartnerLaneMessage,
  type ProviderDnsRecord,
  type ProviderDomain
} from '../provider';

/**
 * Deterministic provider for unit, integration, E2E and wt-stack runs (spec
 * §5.1). Refused in production by config/validate.ts.
 *
 * Behaviour is keyed on the DOMAIN NAME so a test needs no setup:
 *   *.verify.test     -> verifies on the first check
 *   *.fail.test       -> fails verification, and refuses to send (domain_unusable)
 *   conflict.test     -> createDomain raises ProviderDomainConflictError
 *   preexisting.*     -> findDomainByName reports an ALREADY VERIFIED domain
 *                        created in the year 2000, which drives spec §5.1
 *                        case 4 (adopt with provider_managed = false)
 *   anything else     -> stays pending
 *
 * `send` hands the message to the platform transport verbatim, so a local
 * Mailpit shows the custom From.
 */

export const FAKE_PREEXISTING_PREFIX = 'preexisting.';
const PREEXISTING_CREATED_AT = new Date('2000-01-01T00:00:00.000Z');

/** Domains this process has created. Reset between test files. */
const created = new Map<string, { domain: string; createdAt: Date; region?: string }>();

export function resetFakeDomainProviderState(): void {
  created.clear();
}

function fakeId(domain: string): string {
  return `fake-${domain}`;
}

function domainOfId(providerDomainId: string): string {
  return providerDomainId.startsWith('fake-') ? providerDomainId.slice('fake-'.length) : providerDomainId;
}

function stateFor(domain: string): ProviderDomain['state'] {
  if (domain === 'conflict.test' || domain.endsWith('.conflict.test')) return 'pending';
  if (domain === 'fail.test' || domain.endsWith('.fail.test')) return 'failed';
  if (domain === 'verify.test' || domain.endsWith('.verify.test')) return 'verified';
  if (domain.startsWith(FAKE_PREEXISTING_PREFIX)) return 'verified';
  return 'pending';
}

function recordsFor(domain: string, state: ProviderDomain['state']): ProviderDnsRecord[] {
  const status: ProviderDnsRecord['status'] = state === 'verified' ? 'verified' : state === 'failed' ? 'failed' : 'pending';
  return [
    { purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: `resend._domainkey.${domain}`, value: `fake-dkim.${domain}.example`, ttl: 'Auto', status },
    { purpose: 'spf', type: 'TXT', host: 'send', fqdn: `send.${domain}`, value: 'v=spf1 include:fake.example ~all', ttl: 'Auto', status },
    { purpose: 'return_path_mx', type: 'MX', host: 'send', fqdn: `send.${domain}`, value: 'feedback-smtp.fake.example', ttl: 'Auto', priority: 10, status }
  ];
}

function domainFor(domain: string, createdAt: Date, region?: string): ProviderDomain {
  const state = stateFor(domain);
  const result: ProviderDomain = { providerDomainId: fakeId(domain), state, records: recordsFor(domain, state), createdAt };
  if (region) result.region = region;
  return result;
}

export function createFakeDomainProvider(): EmailDomainProvider {
  return {
    id: 'fake',
    verifiesByDns: true,

    async createDomain(input: CreateProviderDomainInput): Promise<ProviderDomain> {
      if (input.domain === 'conflict.test' || input.domain.endsWith('.conflict.test')) {
        throw new ProviderDomainConflictError(input.domain, 'fake provider: this domain is already claimed');
      }
      const createdAt = new Date();
      created.set(input.domain, { domain: input.domain, createdAt, region: input.region });
      return domainFor(input.domain, createdAt, input.region);
    },

    async findDomainByName(domain: string): Promise<ProviderDomain | null> {
      // The `preexisting.` prefix drives §5.1 case 4 without any seeding: the
      // provider reports a domain OLDER than any provision_attempted_at, so
      // W03 must adopt it with provider_managed = false and never delete it.
      if (domain.startsWith(FAKE_PREEXISTING_PREFIX)) {
        return domainFor(domain, PREEXISTING_CREATED_AT);
      }
      const existing = created.get(domain);
      return existing ? domainFor(existing.domain, existing.createdAt, existing.region) : null;
    },

    async getDomain(providerDomainId: string): Promise<ProviderDomain> {
      const domain = domainOfId(providerDomainId);
      const existing = created.get(domain);
      return domainFor(domain, existing?.createdAt ?? PREEXISTING_CREATED_AT, existing?.region);
    },

    async requestVerification(): Promise<void> {
      // Verification is decided by the domain name, so this is a no-op.
    },

    async deleteDomain(providerDomainId: string): Promise<void> {
      // Deleting an unknown id is success — the 404-as-success contract.
      created.delete(domainOfId(providerDomainId));
    },

    async listDomains(): Promise<Array<{ providerDomainId: string; domain: string }>> {
      return [...created.values()].map((entry) => ({ providerDomainId: fakeId(entry.domain), domain: entry.domain }));
    },

    async send(m: PartnerLaneMessage & { partnerRef: string; tags: Record<string, string> }) {
      const fromDomain = (m.from.match(/<([^<>\s]+@([^<>\s]+))>/)?.[2] ?? m.from.split('@')[1] ?? '').toLowerCase();
      if (fromDomain === 'fail.test' || fromDomain.endsWith('.fail.test')) {
        throw new PartnerLaneSendFailure({ kind: 'domain_unusable' });
      }
      const service = getEmailService();
      if (!service) throw new PartnerLaneSendFailure({ kind: 'lane_unavailable' });
      const { partnerRef: _partnerRef, tags: _tags, ...raw } = m;
      void _partnerRef;
      void _tags;
      try {
        await service.deliverRaw(raw);
      } catch (err) {
        throw new PartnerLaneSendFailure({ kind: 'ambiguous', detail: err instanceof Error ? err.message : String(err) });
      }
      return { providerMessageId: `fake:${Date.now().toString(36)}` };
    }
  };
}
