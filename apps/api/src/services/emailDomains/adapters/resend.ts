import { Resend } from 'resend';
import { getEmailDomainsConfig } from '../config';
import {
  PartnerLaneSendFailure,
  ProviderDomainConflictError,
  ProviderDomainRejectedError,
  type CreateProviderDomainInput,
  type EmailDomainProvider,
  type PartnerLaneMessage,
  type PartnerLaneSendError,
  type ProviderDnsRecord,
  type ProviderDomain
} from '../provider';

export { RESEND_SEND_ERROR_FIXTURES } from './resendSendErrorFixtures';

/** The four regions the SDK's DomainRegion union allows (index.d.mts:39). */
const RESEND_REGIONS = ['us-east-1', 'eu-west-1', 'sa-east-1', 'ap-northeast-1'] as const;
type ResendRegion = (typeof RESEND_REGIONS)[number];

interface ResendErrorShape { name: string; statusCode: number | null; message: string }

/**
 * Spec §5.2, keyed on whether SENDING is usable.
 *
 * `temporary_failure` is not in resend@6.18.0's DomainStatus union — it only
 * appears on DomainRecordStatus — but the live API does return it at domain
 * level (spec §0.2), so it is matched as a runtime string. Anything unknown
 * maps to `pending` and warns: the unknown case must never send.
 */
export function mapResendDomainStatus(raw: string): ProviderDomain['state'] {
  switch (raw) {
    case 'not_started':
    case 'pending':
      return 'pending';
    case 'verified':
    case 'partially_verified':
      return 'verified';
    case 'temporary_failure':
    case 'partially_failed':
      return 'at_risk';
    case 'failed':
      return 'failed';
    default:
      console.warn(`[emailDomains/resend] Unknown domain status ${JSON.stringify(raw)}; treating as pending so it cannot send.`);
      return 'pending';
  }
}

function mapRecordStatus(raw: unknown): ProviderDnsRecord['status'] {
  // not_started and temporary_failure both mean "not proven yet" for display.
  return raw === 'verified' ? 'verified' : raw === 'failed' ? 'failed' : 'pending';
}

function mapRecordPurpose(record: unknown, type: unknown): ProviderDnsRecord['purpose'] {
  if (record === 'DKIM') return 'dkim';
  if (record === 'SPF') return type === 'MX' ? 'return_path_mx' : 'spf';
  return 'other';
}

/** `send` -> `send.acme.com`; `@`/`''` -> the apex; an already-absolute host is left alone. */
function toFqdn(host: string, domain: string): string {
  const trimmed = host.trim().replace(/\.+$/, '');
  if (trimmed === '' || trimmed === '@') return domain;
  if (trimmed === domain || trimmed.endsWith(`.${domain}`)) return trimmed;
  return `${trimmed}.${domain}`;
}

export function normalizeResendRecords(domain: string, records: unknown[]): ProviderDnsRecord[] {
  const out: ProviderDnsRecord[] = [];
  for (const raw of records ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const type = r.type;
    // CAA (the tracking CAA record) has no place in ProviderDnsRecord's type
    // union and we never enable click/open tracking, so it is dropped rather
    // than shown to a partner as something to publish.
    if (type !== 'TXT' && type !== 'CNAME' && type !== 'MX') continue;
    const host = typeof r.name === 'string' ? r.name : '';
    const value = typeof r.value === 'string' ? r.value : '';
    const record: ProviderDnsRecord = {
      purpose: mapRecordPurpose(r.record, type),
      type,
      host,
      fqdn: toFqdn(host, domain),
      value,
      status: mapRecordStatus(r.status)
    };
    if (typeof r.ttl === 'string') record.ttl = r.ttl;
    if (typeof r.priority === 'number') record.priority = r.priority;
    out.push(record);
  }
  return out;
}

/**
 * Four kinds (spec §5). ORDER IS LOAD-BEARING: the domain-refusal text is
 * checked before the generic validation_error rule, because Resend returns
 * `validation_error` for "the domain is not verified" and misclassifying that
 * as `message_rejected` would LOSE the message instead of falling back to the
 * platform lane.
 *
 * The default is `ambiguous`, never `message_rejected`: §8.4 never retries an
 * ambiguous failure on the other lane, so a wrong guess there cannot produce a
 * duplicate — while a wrong `domain_unusable` guess only costs one harmless
 * platform-lane send.
 */
export function classifyResendSendError(error: ResendErrorShape): PartnerLaneSendError {
  const name = error?.name ?? '';
  const status = error?.statusCode ?? null;
  const message = error?.message ?? '';
  const lower = message.toLowerCase();

  const looksLikeDomainRefusal =
    lower.includes('not verified') ||
    lower.includes('domain is not') ||
    lower.includes('verify your domain') ||
    lower.includes('verify a domain') ||
    lower.includes('domain not found');

  if (name === 'invalid_from_address') return { kind: 'domain_unusable' };
  if (looksLikeDomainRefusal) return { kind: 'domain_unusable' };
  if (name === 'not_found' && lower.includes('domain')) return { kind: 'domain_unusable' };

  if (
    name === 'rate_limit_exceeded' ||
    name === 'daily_quota_exceeded' ||
    name === 'monthly_quota_exceeded' ||
    name === 'missing_api_key' ||
    name === 'invalid_api_key' ||
    name === 'restricted_api_key' ||
    name === 'invalid_access' ||
    name === 'security_error' ||
    status === 429
  ) {
    return { kind: 'lane_unavailable' };
  }

  if (
    name === 'validation_error' ||
    name === 'invalid_parameter' ||
    name === 'missing_required_field' ||
    name === 'invalid_attachment' ||
    name === 'invalid_idempotency_key' ||
    status === 413
  ) {
    return { kind: 'message_rejected', detail: message };
  }

  return { kind: 'ambiguous', detail: `${name}${status === null ? '' : ` (${status})`}: ${message}` };
}

/** Resend tag values accept ASCII letters, digits, `_` and `-` only. */
function sanitizeTagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);
}

function resolveRegion(): ResendRegion {
  const configured = getEmailDomainsConfig().region;
  if (!(RESEND_REGIONS as readonly string[]).includes(configured)) {
    throw new Error(
      `[emailDomains/resend] EMAIL_DOMAINS_REGION=${JSON.stringify(configured)} is not a Resend region. Use one of ${RESEND_REGIONS.join(', ')}.`
    );
  }
  return configured as ResendRegion;
}

function toProviderDomain(data: Record<string, unknown>, domainName: string): ProviderDomain {
  const createdRaw = data.created_at;
  const created = typeof createdRaw === 'string' ? new Date(createdRaw) : undefined;
  const result: ProviderDomain = {
    providerDomainId: String(data.id),
    state: mapResendDomainStatus(String(data.status)),
    records: normalizeResendRecords(domainName, Array.isArray(data.records) ? data.records : [])
  };
  if (typeof data.region === 'string') result.region = data.region;
  if (created && !Number.isNaN(created.getTime())) result.createdAt = created;
  return result;
}

export function createResendDomainProvider(): EmailDomainProvider {
  const config = getEmailDomainsConfig();
  // The adapter NEVER falls back to RESEND_API_KEY: a self-hoster's existing key
  // is almost always sending_access, which cannot manage domains (spec §5.1).
  const management = new Resend(config.resendApiKey ?? undefined);
  const sending = config.resendSendingKey && config.resendSendingKey !== config.resendApiKey
    ? new Resend(config.resendSendingKey)
    : management;

  return {
    id: 'resend',
    verifiesByDns: true,

    async createDomain(input: CreateProviderDomainInput): Promise<ProviderDomain> {
      const region = resolveRegion();
      // camelCase payload: `customReturnPath` is the PUBLIC field name in
      // resend@6.18.0; the snake_case form is the internal wire type. We leave
      // the return path at its default (`send`), which is what §4.2 documents.
      const { data, error } = await management.domains.create({ name: input.domain, region });
      if (error) {
        const lower = (error.message ?? '').toLowerCase();
        if (lower.includes('already exists') || lower.includes('already registered') || error.statusCode === 409) {
          throw new ProviderDomainConflictError(input.domain, error.message);
        }
        throw new ProviderDomainRejectedError(input.domain, `${error.name}: ${error.message}`);
      }
      return toProviderDomain(data as unknown as Record<string, unknown>, input.domain);
    },

    async findDomainByName(domain: string): Promise<ProviderDomain | null> {
      const { data, error } = await management.domains.list();
      if (error) {
        // Reporting "not found" on a list failure would make W03 create a
        // domain the account already holds, which is the one call that can
        // trigger Resend's cross-team claim flow. Throw instead.
        throw new Error(`[emailDomains/resend] listDomains failed: ${error.name}: ${error.message}`);
      }
      const target = domain.trim().toLowerCase();
      const match = (data?.data ?? []).find((d) => String(d.name).trim().toLowerCase() === target);
      if (!match) return null;
      // list() returns no records[] — fetch the full object.
      return this.getDomain(String(match.id));
    },

    async getDomain(providerDomainId: string): Promise<ProviderDomain> {
      const { data, error } = await management.domains.get(providerDomainId);
      if (error) throw new Error(`[emailDomains/resend] getDomain failed: ${error.name}: ${error.message}`);
      const record = data as unknown as Record<string, unknown>;
      return toProviderDomain(record, String(record.name ?? ''));
    },

    async requestVerification(providerDomainId: string): Promise<void> {
      // The response carries only the id — it does NOT report the new status,
      // so callers that need one follow with getDomain on the next sweep.
      const { error } = await management.domains.verify(providerDomainId);
      if (error) throw new Error(`[emailDomains/resend] verify failed: ${error.name}: ${error.message}`);
    },

    async deleteDomain(providerDomainId: string): Promise<void> {
      const { error } = await management.domains.remove(providerDomainId);
      // 404 is success: the domain is already gone, which is the state we want.
      if (error && error.statusCode !== 404 && error.name !== 'not_found') {
        throw new Error(`[emailDomains/resend] deleteDomain failed: ${error.name}: ${error.message}`);
      }
    },

    async listDomains(): Promise<Array<{ providerDomainId: string; domain: string }>> {
      const { data, error } = await management.domains.list();
      if (error) throw new Error(`[emailDomains/resend] listDomains failed: ${error.name}: ${error.message}`);
      return (data?.data ?? []).map((d) => ({ providerDomainId: String(d.id), domain: String(d.name) }));
    },

    async send(m: PartnerLaneMessage & { partnerRef: string; tags: Record<string, string> }) {
      const { data, error } = await sending.emails.send({
        from: m.from,
        to: m.to,
        cc: m.cc,
        subject: m.subject,
        html: m.html,
        text: m.text,
        replyTo: m.replyTo,
        headers: m.headers,
        attachments: m.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType
        })),
        tags: Object.entries(m.tags).map(([name, value]) => ({ name, value: sanitizeTagValue(value) }))
      } as Parameters<typeof sending.emails.send>[0]);
      if (error) throw new PartnerLaneSendFailure(classifyResendSendError(error));
      return { providerMessageId: String(data!.id) };
    }
  };
}
