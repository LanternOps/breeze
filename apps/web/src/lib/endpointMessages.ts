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
  | 'queue_failed';

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
