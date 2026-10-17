import {
  agentSupportsEndpointMessaging,
  type EndpointMessageSendInput,
  type EndpointMessageSeverity,
} from '@breeze/shared';
import { fetchWithAuth } from '../stores/auth';
import { runAction, type RunActionOptions } from './runAction';

export type MessagingCapability = 'assist_card' | 'native' | 'unsupported';

export type EndpointMessageErrorCode =
  | 'agent_unsupported'
  | 'no_permission'
  | 'offline_rejected'
  | 'rate_limited'
  | 'cap_exceeded'
  | 'feature_disabled'
  | 'queue_failed'
  | 'in_progress'
  | 'unavailable'
  | 'no_devices_resolved'
  | 'idempotency_conflict';

export type EndpointMessageIssueKey =
  | 'html'
  | 'images'
  | 'httpsLinks'
  | 'referenceLinks'
  | 'titleHtml'
  | 'titleLinks'
  | 'invalid';

/**
 * Maps one English issue string from the shared validator
 * (`endpointMessageContentIssues`) to a locale key under
 * `endpointMessages.issues.*`, so the UI never renders raw English.
 */
export function endpointMessageIssueKey(issue: string): EndpointMessageIssueKey {
  if (issue.startsWith('title:')) {
    if (issue.includes('html')) return 'titleHtml';
    if (issue.includes('link')) return 'titleLinks';
    return 'invalid';
  }
  if (issue.includes('reference')) return 'referenceLinks';
  if (issue.includes('image')) return 'images';
  if (issue.includes('html')) return 'html';
  if (issue.includes('https')) return 'httpsLinks';
  return 'invalid';
}

export interface EndpointMessageResult {
  deviceId: string;
  orgId: string;
  status: 'queued' | 'failed';
  commandId?: string;
  errorCode?: EndpointMessageErrorCode | string;
}

export interface EndpointMessageSendResponse {
  batchId: string;
  deviceCount: number;
  results: EndpointMessageResult[];
}

/** Request body for POST /endpoint-messages (the shared validator's input shape, defaults filled in). */
export type EndpointMessageRequest = Omit<EndpointMessageSendInput, 'requiresAck' | 'expiresInMinutes'> & {
  requiresAck: boolean;
  expiresInMinutes: number | null;
  severity: EndpointMessageSeverity;
};

/**
 * What the device will do with a message, from device data alone. The agent
 * version gate is the shared one the API enforces, so the column never promises
 * a delivery the API would reject. Windows shows the Assist card in the console
 * session (native notification is the fallback when no helper is running);
 * macOS and Linux always use the native notification.
 */
export function deviceMessagingCapability(device: {
  osType: 'windows' | 'macos' | 'linux' | string;
  agentVersion: string | null | undefined;
}): MessagingCapability {
  if (!agentSupportsEndpointMessaging(device.agentVersion)) return 'unsupported';
  return device.osType === 'windows' ? 'assist_card' : 'native';
}

type SendOptions = Pick<
  RunActionOptions<EndpointMessageSendResponse>,
  'errorFallback' | 'friendly' | 'suppressErrorToast' | 'onUnauthorized'
>;

/**
 * POST /endpoint-messages. The same `messageId` on a retry makes the API
 * replay the first response instead of queuing a second card, so callers must
 * reuse it across retries of one compose.
 */
export function sendEndpointMessage(
  input: EndpointMessageRequest,
  opts: SendOptions,
): Promise<EndpointMessageSendResponse> {
  return runAction<EndpointMessageSendResponse>({
    ...opts,
    request: () =>
      fetchWithAuth('/endpoint-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
  });
}

export type EndpointMessageDeliveryStatus =
  | 'queued'
  | 'delivered'
  | 'displayed'
  | 'acknowledged'
  | 'dismissed'
  | 'expired'
  | 'retracted'
  | 'failed'
  | 'superseded';

export interface EndpointMessageListItem {
  id: string;
  orgId: string;
  batchId: string;
  /** Null once the 90-day body purge has run. */
  title: string | null;
  severity: EndpointMessageSeverity;
  requiresAck: boolean;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  retractedAt: string | null;
  bodyPurged: boolean;
  aiInitiated: boolean;
  resendOfId: string | null;
  deviceCount: number;
  statusCounts: Partial<Record<EndpointMessageDeliveryStatus, number>>;
}

export interface EndpointMessageReceipt {
  sessionUsername: string | null;
  eventType: 'displayed' | 'acknowledged' | 'dismissed' | 'expired';
  occurredAt: string;
}

export interface EndpointMessageDelivery {
  id: string;
  deviceId: string;
  hostname: string | null;
  siteId: string | null;
  status: EndpointMessageDeliveryStatus;
  surface: 'assist' | 'native' | null;
  errorCode: string | null;
  deliveredAt: string | null;
  displayedAt: string | null;
  acknowledgedAt: string | null;
  dismissedAt: string | null;
  retractedAt: string | null;
  receipts: EndpointMessageReceipt[];
}

export interface EndpointMessageDetail extends EndpointMessageListItem {
  body: string | null;
  deliveries: EndpointMessageDelivery[];
}

export interface EndpointMessageListPage {
  items: EndpointMessageListItem[];
  nextCursor: string | null;
}

export interface EndpointMessageRetractResponse {
  id: string;
  retractedAt: string;
  alreadyRetracted: boolean;
  results: Array<
    | { deviceId: string; status: 'retracted'; via: 'cancelled' | 'command' | 'expired' }
    | { deviceId: string; status: 'failed'; errorCode: string }
  >;
}

type MutationOptions<T> = Pick<
  RunActionOptions<T>,
  'errorFallback' | 'friendly' | 'suppressErrorToast' | 'onUnauthorized' | 'successMessage'
>;

/** GET /endpoint-messages: one page of batches, newest first. */
export async function listEndpointMessages(
  params: { limit?: number; cursor?: string | null } = {},
): Promise<EndpointMessageListPage> {
  const qs = new URLSearchParams();
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.cursor) qs.set('cursor', params.cursor);
  const query = qs.toString();
  const response = await fetchWithAuth(`/endpoint-messages${query ? `?${query}` : ''}`);
  if (!response.ok) throw new Error(`list_failed_${response.status}`);
  return (await response.json()) as EndpointMessageListPage;
}

/** GET /endpoint-messages/:id. Null when the message does not exist (404). */
export async function getEndpointMessage(id: string): Promise<EndpointMessageDetail | null> {
  const response = await fetchWithAuth(`/endpoint-messages/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`detail_failed_${response.status}`);
  return (await response.json()) as EndpointMessageDetail;
}

/** POST /endpoint-messages/:id/retract (no body). */
export function retractEndpointMessage(
  id: string,
  opts: MutationOptions<EndpointMessageRetractResponse>,
): Promise<EndpointMessageRetractResponse> {
  return runAction<EndpointMessageRetractResponse>({
    ...opts,
    request: () => fetchWithAuth(`/endpoint-messages/${encodeURIComponent(id)}/retract`, { method: 'POST' }),
  });
}

/**
 * POST /endpoint-messages/:id/resend. `messageId` is a fresh client uuid: the
 * API replays the first response on a repeat of the same one.
 */
export function resendEndpointMessage(
  id: string,
  messageId: string,
  opts: MutationOptions<EndpointMessageSendResponse>,
): Promise<EndpointMessageSendResponse> {
  return runAction<EndpointMessageSendResponse>({
    ...opts,
    request: () =>
      fetchWithAuth(`/endpoint-messages/${encodeURIComponent(id)}/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId }),
      }),
  });
}
