import { z } from 'zod';
import { semverCompare } from '../utils/semverCompare';
import { endpointMessageBodyIssues } from './endpointMessage';

/**
 * Endpoint live chat (#8292, W03 of #8740). A technician opens an ad-hoc chat
 * with the person at a Windows device (Assist helper, console session only);
 * the user can reply when the org's `allowUserReply` toggle is on. These
 * limits are enforced by the API routes AND re-checked by the agent and helper.
 */
export const ENDPOINT_CHAT_LIMITS = {
  bodyMax: 2000,
  senderNameMax: 120,
  /** Technician messages per conversation per hour (plan Task 3.3). */
  techMessagesPerHourPerConversation: 60,
  /** End-user replies per conversation per hour. */
  userRepliesPerHourPerConversation: 120,
  /** Conversations an actor may open per hour. */
  opensPerHourPerActor: 30,
  /** An open conversation with no activity for this long is closed (`expired`). */
  idleCloseMinutes: 30,
  /** An `opening` conversation the agent never confirmed is failed after this. */
  openTimeoutMinutes: 2,
  /** Messages returned by one conversation read. */
  maxMessagesPerRead: 500,
} as const;

/**
 * Oldest agent release a chat is opened on. The chat handlers have shipped
 * since v0.124.0; the floor is 0.128.0 because that is the agent and Breeze
 * Assist version the chat window and reply path were proved on in the Windows
 * lab. Below it the API answers `agent_unsupported`.
 */
export const ENDPOINT_CHAT_MIN_AGENT_VERSION = '0.128.0';

/** False for null, unparseable and older versions — never guesses in favour. */
export function agentSupportsEndpointChat(agentVersion: string | null | undefined): boolean {
  if (typeof agentVersion !== 'string' || agentVersion.trim() === '') return false;
  const cmp = semverCompare(agentVersion.trim(), ENDPOINT_CHAT_MIN_AGENT_VERSION);
  return cmp !== null && cmp >= 0;
}

/** Technician chat bodies use the endpoint-message body rules (same helper renderer). */
export function endpointChatBodyIssues(body: string): string[] {
  return endpointMessageBodyIssues(body);
}

const chatBody = z
  .string()
  .trim()
  .min(1)
  .max(ENDPOINT_CHAT_LIMITS.bodyMax)
  .superRefine((body, ctx) => {
    for (const issue of endpointChatBodyIssues(body)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `body: ${issue}` });
    }
  });

/** Open a conversation with its first technician message ("incoming call"). */
export const endpointChatOpenSchema = z
  .object({
    /** Client-generated; a retry with the same id never opens a second chat. */
    conversationId: z.string().uuid(),
    deviceId: z.string().uuid(),
    body: chatBody,
  })
  .strict();

/** A later technician message in an open conversation. */
export const endpointChatMessageSchema = z
  .object({
    /** Client-generated; a retry with the same id never sends a second message. */
    messageId: z.string().uuid(),
    body: chatBody,
  })
  .strict();

export type EndpointChatOpenInput = z.infer<typeof endpointChatOpenSchema>;
export type EndpointChatMessageInput = z.infer<typeof endpointChatMessageSchema>;

export const ENDPOINT_CONVERSATION_STATUSES = ['opening', 'open', 'closed', 'expired', 'failed'] as const;
export type EndpointConversationStatus = (typeof ENDPOINT_CONVERSATION_STATUSES)[number];
export type EndpointChatDirection = 'to_user' | 'from_user';
