/**
 * Wisp thread timeline (feature #10210): one newest-first, keyset-paged feed
 * merging the thread's chat messages with durable proactive Wisp posts.
 */
import type { BriefSection } from './wispActivity';

/** Default page size for the timeline. */
export const WISP_TIMELINE_DEFAULT_LIMIT = 50;
/** Largest page size the timeline accepts. */
export const WISP_TIMELINE_MAX_LIMIT = 100;

/** What kind of proactive output a post carries. */
export type WispTimelinePostKind = 'brief' | 'nudge' | 'digest';

/** An ai_messages row from one of the thread's sessions. */
export type WispTimelineMessage = {
  source: 'message';
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string | null;
  contentBlocks: unknown | null;
  toolName: string | null;
  toolInput: unknown | null;
  toolOutput: unknown | null;
  toolUseId: string | null;
  createdAt: string; // ISO
};

/** Durable proactive Wisp output (brief, nudge, digest) posted on the thread. */
export type WispTimelinePost = {
  source: 'post';
  id: string;
  kind: WispTimelinePostKind;
  title: string;
  body: string | null;
  link: string | null;
  sections: BriefSection[] | null;
  concernId: string | null;
  orgId: string | null;
  read: boolean | null; // the linked notification's read flag, null when unlinked
  createdAt: string;
};

/** One timeline entry, discriminated on `source`. */
export type WispTimelineItem = WispTimelineMessage | WispTimelinePost;

/** `GET /wisp/thread/:id/timeline` response: newest first, `nextCursor` is the keyset cursor. */
export interface WispTimelineResponse {
  data: { items: WispTimelineItem[]; nextCursor: string | null };
}
