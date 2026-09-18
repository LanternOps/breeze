import type { PartnerLaneSendError } from '../provider';

/**
 * Recorded Resend send-error shapes.
 *
 * Spec §0.2 lists the exact error Resend returns for a send from an unverified
 * domain as NOT VERIFIED against the live API. These entries are the best
 * current reading of the SDK's error codes; W03's lab step (a real send from a
 * pending domain on the partner-lane account) REPLACES the `error` payloads
 * below with what the API actually returned and, if a classification is wrong,
 * fixes classifyResendSendError rather than the expectation.
 *
 * `source: 'observed'` means someone recorded it from a live call.
 */
export interface ResendSendErrorFixture {
  label: string;
  source: 'assumed' | 'observed';
  error: { name: string; statusCode: number | null; message: string };
  expectedKind: PartnerLaneSendError['kind'];
}

export const RESEND_SEND_ERROR_FIXTURES: readonly ResendSendErrorFixture[] = [
  {
    label: 'send from a domain that has not verified yet',
    source: 'assumed',
    error: { name: 'validation_error', statusCode: 403, message: 'The acme.com domain is not verified. Please, add and verify your domain on https://resend.com/domains' },
    expectedKind: 'domain_unusable'
  },
  {
    label: 'send from a domain that is not in the account at all',
    source: 'assumed',
    error: { name: 'validation_error', statusCode: 403, message: 'You can only send testing emails to your own email address. To send emails to other recipients, please verify a domain.' },
    expectedKind: 'domain_unusable'
  },
  {
    label: 'malformed From header',
    source: 'assumed',
    error: { name: 'invalid_from_address', statusCode: 422, message: 'Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.' },
    expectedKind: 'domain_unusable'
  },
  {
    label: 'account rate limit (10 req/s per team)',
    source: 'assumed',
    error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests. You can only make 10 requests per second.' },
    expectedKind: 'lane_unavailable'
  },
  {
    label: 'daily quota exhausted',
    source: 'assumed',
    error: { name: 'daily_quota_exceeded', statusCode: 429, message: 'You have reached your daily email sending quota.' },
    expectedKind: 'lane_unavailable'
  },
  {
    label: 'sending-only key used for a management call',
    source: 'assumed',
    error: { name: 'restricted_api_key', statusCode: 401, message: 'This API key is restricted to only send emails.' },
    expectedKind: 'lane_unavailable'
  },
  {
    label: 'bad recipient address',
    source: 'assumed',
    error: { name: 'validation_error', statusCode: 422, message: 'Invalid `to` field. Please use the correct email format.' },
    expectedKind: 'message_rejected'
  },
  {
    label: 'attachment over the size limit',
    source: 'assumed',
    error: { name: 'invalid_attachment', statusCode: 422, message: 'Attachment is too large.' },
    expectedKind: 'message_rejected'
  },
  {
    label: 'provider 5xx',
    source: 'assumed',
    error: { name: 'application_error', statusCode: 500, message: 'Internal server error. We are unable to process your request right now, please try again later.' },
    expectedKind: 'ambiguous'
  },
  {
    label: 'network failure — the SDK reports statusCode null, never reached Resend',
    source: 'assumed',
    error: { name: 'application_error', statusCode: null, message: 'Unable to fetch data. The request could not be resolved.' },
    expectedKind: 'ambiguous'
  }
];
