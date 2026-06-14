/**
 * The Outlook tool layer, keyed by wire tool name (byte-identical to the server
 * registry keys in clientAiTools.ts). The three read tools auto-execute; the one
 * mutating tool (draft_reply) is approval-gated by the core via
 * OUTLOOK_MUTATING_TOOLS.
 */
import type { ToolExecutor } from '@breeze/office-addin-core';
import { summarizeThread } from './summarizeThread';
import { extractActionItems } from './extractActionItems';
import { getMessageMetadata } from './getMessageMetadata';
import { draftReply } from './draftReply';

export const OUTLOOK_TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  summarize_thread: summarizeThread,
  extract_action_items: extractActionItems,
  get_message_metadata: getMessageMetadata,
  draft_reply: draftReply,
};

export const OUTLOOK_MUTATING_TOOLS: ReadonlySet<string> = new Set(['draft_reply']);
