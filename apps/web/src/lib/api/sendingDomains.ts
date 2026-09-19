import type {
  PartnerMailStreamValue,
  SenderIdentityDto,
  SendingDomainDto,
  SendingDomainsListResponse,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { i18n } from '../i18n';
import { runAction } from '../runAction';

/**
 * The seven partner routes of the sending-domains spec (§7). Every mutation is
 * wrapped in `runAction` HERE rather than at the call sites, so a component can
 * never issue a silent mutation through this module — which is also what
 * satisfies apps/web/src/lib/__tests__/no-silent-mutations.test.ts for callers
 * (`isMutatingApiWrapper` only flags a caller when the wrapper's own
 * fetchWithAuth is unwrapped).
 */
export const SENDING_DOMAINS_PATH = '/partner/sending-domains';

/**
 * fetchWithAuth injects the ambient `?orgId=` by default
 * (stores/auth.ts:1335-1343). This surface is partner-axis: the parameter means
 * nothing to the route and would make the request URL change with the org
 * picker, which the E2E response matchers would then have to tolerate. Opt out
 * on every call.
 */
const NO_ORG = { skipOrgIdInjection: true } as const;

export type SendingDomainsFetch =
  | { supported: true; data: SendingDomainsListResponse }
  | { supported: false };

/**
 * Read. A 404 is not an error here: with EMAIL_DOMAINS_PROVIDER unset every
 * route answers `404 sending_domains_unsupported` before any auth-specific gate,
 * which is how the caller learns to hide the tab.
 */
export async function fetchSendingDomains(): Promise<SendingDomainsFetch> {
  // Inlined (not the `NO_ORG` const) so the no-silent-mutations guard's static
  // check — which cannot see through an identifier's initializer — sees a
  // plain object literal with no `method` property and correctly classifies
  // this as the GET it is, rather than conservatively flagging it as an
  // unwrapped mutation.
  const response = await fetchWithAuth(SENDING_DOMAINS_PATH, { skipOrgIdInjection: true });
  if (response.status === 404) return { supported: false };
  if (!response.ok) throw new Error(`sending_domains_fetch_failed_${response.status}`);
  return { supported: true, data: (await response.json()) as SendingDomainsListResponse };
}

/**
 * Machine error token -> partner-facing copy. runAction calls this with
 * `body.code ?? body.error`; these routes emit a bare `error` token, so the
 * token is what arrives. Returning undefined leaves the server's own prose.
 */
export function sendingDomainFriendlyError(maxDomains: number): (code: string) => string | undefined {
  return (code: string): string | undefined => {
    switch (code) {
      case 'domain_unavailable':
        return i18n.t('settings:partnerSendingDomains.errorDomainUnavailable');
      case 'domain_limit_reached':
        return i18n.t('settings:partnerSendingDomains.errorDomainLimitReached', { max: maxDomains });
      case 'rate_limited':
        return i18n.t('settings:partnerSendingDomains.errorRateLimited');
      case 'not_found':
        return i18n.t('settings:partnerSendingDomains.errorNotFound');
      case 'domain_not_sendable':
        return i18n.t('settings:partnerSendingDomains.errorDomainNotSendable');
      case 'domain_invalid':
        return i18n.t('settings:partnerSendingDomains.addInvalid');
      case 'sending_domains_unsupported':
        return i18n.t('settings:partnerSendingDomains.errorUnsupported');
      default:
        return undefined;
    }
  };
}

interface MutationBase {
  maxDomains: number;
  onUnauthorized: () => void;
}

export async function createSendingDomain(
  input: MutationBase & { domain: string },
): Promise<SendingDomainDto> {
  return runAction<SendingDomainDto>({
    request: () =>
      fetchWithAuth(SENDING_DOMAINS_PATH, {
        method: 'POST',
        body: JSON.stringify({ domain: input.domain }),
        ...NO_ORG,
      }),
    successMessage: i18n.t('settings:partnerSendingDomains.added'),
    errorFallback: i18n.t('settings:partnerSendingDomains.errorAddFailed'),
    friendly: sendingDomainFriendlyError(input.maxDomains),
    onUnauthorized: input.onUnauthorized,
  });
}

export async function requestSendingDomainCheck(
  input: MutationBase & { domainId: string },
): Promise<SendingDomainDto> {
  return runAction<SendingDomainDto>({
    request: () =>
      fetchWithAuth(`${SENDING_DOMAINS_PATH}/${input.domainId}/check`, { method: 'POST', ...NO_ORG }),
    successMessage: i18n.t('settings:partnerSendingDomains.checkStarted'),
    errorFallback: i18n.t('settings:partnerSendingDomains.errorCheckFailed'),
    friendly: sendingDomainFriendlyError(input.maxDomains),
    onUnauthorized: input.onUnauthorized,
  });
}

export async function removeSendingDomain(input: MutationBase & { domainId: string }): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth(`${SENDING_DOMAINS_PATH}/${input.domainId}`, { method: 'DELETE', ...NO_ORG }),
    successMessage: i18n.t('settings:partnerSendingDomains.removeStarted'),
    errorFallback: i18n.t('settings:partnerSendingDomains.errorRemoveFailed'),
    friendly: sendingDomainFriendlyError(input.maxDomains),
    onUnauthorized: input.onUnauthorized,
  });
}

export async function upsertSenderIdentity(
  input: MutationBase & {
    stream: PartnerMailStreamValue;
    sendingDomainId: string;
    localPart: string;
    displayName: string | null;
    replyTo: string | null;
  },
): Promise<SenderIdentityDto> {
  return runAction<SenderIdentityDto>({
    request: () =>
      // `stream` is a path parameter, never a body field (W03's
      // upsertSenderIdentitySchema is .strict() and rejects it in the body).
      fetchWithAuth(`${SENDING_DOMAINS_PATH}/identities/${input.stream}`, {
        method: 'PUT',
        body: JSON.stringify({
          sendingDomainId: input.sendingDomainId,
          localPart: input.localPart,
          displayName: input.displayName,
          replyTo: input.replyTo,
        }),
        ...NO_ORG,
      }),
    successMessage: i18n.t('settings:partnerSendingDomains.identitySaved'),
    errorFallback: i18n.t('settings:partnerSendingDomains.errorIdentityFailed'),
    friendly: sendingDomainFriendlyError(input.maxDomains),
    onUnauthorized: input.onUnauthorized,
  });
}

export async function deleteSenderIdentity(
  input: MutationBase & { stream: PartnerMailStreamValue },
): Promise<void> {
  // The route answers 204 with no body. runAction's `response.json()` rejects,
  // is caught to `null`, and `isApiFailure(null, 204)` is false — so this is a
  // success path, not a silent failure.
  await runAction({
    request: () =>
      fetchWithAuth(`${SENDING_DOMAINS_PATH}/identities/${input.stream}`, { method: 'DELETE', ...NO_ORG }),
    successMessage: i18n.t('settings:partnerSendingDomains.identityCleared'),
    errorFallback: i18n.t('settings:partnerSendingDomains.errorIdentityFailed'),
    friendly: sendingDomainFriendlyError(input.maxDomains),
    onUnauthorized: input.onUnauthorized,
  });
}

export async function sendSendingDomainTest(
  input: MutationBase & { domainId: string },
): Promise<void> {
  // The recipient is always the calling user's own address, taken from the auth
  // context server-side. There is deliberately no body.
  await runAction({
    request: () =>
      fetchWithAuth(`${SENDING_DOMAINS_PATH}/${input.domainId}/test`, { method: 'POST', ...NO_ORG }),
    successMessage: i18n.t('settings:partnerSendingDomains.testQueued'),
    errorFallback: i18n.t('settings:partnerSendingDomains.errorTestFailed'),
    friendly: sendingDomainFriendlyError(input.maxDomains),
    onUnauthorized: input.onUnauthorized,
  });
}
