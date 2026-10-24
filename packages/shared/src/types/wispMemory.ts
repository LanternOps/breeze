/**
 * Wisp memory (W03, feature #9906): the closed value sets of `ai_memory_blocks`
 * and the DTO the `/api/v1/wisp/memory` routes return.
 *
 * Each array mirrors a CHECK constraint in
 * apps/api/migrations/2027-01-04-110100-ai-memory-blocks.sql — change both
 * together. The API's broker-level `MemoryBlockType` (services/wisp/memoryBroker.ts)
 * is the same set; this module names it `MemoryBlockTypeName` so the two never
 * collide on a shared import.
 */

export const MEMORY_OWNER_KINDS = ['user', 'org', 'partner'] as const;
export type MemoryOwnerKind = (typeof MEMORY_OWNER_KINDS)[number];

/** `work_summary`: what a working session did; org-owned, `content.evidence` points at Breeze records. */
export const MEMORY_BLOCK_TYPES = [
  'preference',
  'standing_instruction',
  'fact',
  'decision',
  'concern_outcome',
  'work_summary',
] as const;
export type MemoryBlockTypeName = (typeof MEMORY_BLOCK_TYPES)[number];

export const MEMORY_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number];

export const MEMORY_BLOCK_STATUSES = ['unconfirmed', 'confirmed', 'retracted'] as const;
export type MemoryBlockStatus = (typeof MEMORY_BLOCK_STATUSES)[number];

/** Wire shape of one memory block (timestamps ISO-8601). */
export type MemoryBlockDto = {
  id: string;
  ownerKind: MemoryOwnerKind;
  ownerUserId: string | null;
  ownerOrgId: string | null;
  blockType: MemoryBlockTypeName;
  subjectKey: string;
  content: Record<string, unknown>;
  confidence: MemoryConfidence;
  status: MemoryBlockStatus;
  authoredByGrantId: string | null;
  supersededById: string | null;
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
};
