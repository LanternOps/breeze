// W02a-owned: the contract every Trust Center W2 section module implements (plan "Section seam").
import type { TrustPagePublicPayload, TrustPublishedConfigResolved } from '@breeze/shared';
import type { TrustPageRow } from '../../../db/schema/trustPages';

/** Publish/preview: what a section reads to decide what it freezes into published_config. */
export interface SectionDraftContext {
  page: TrustPageRow;
  asOf: Date;
}

/** Every build (draft or frozen): a section renders ONLY from the resolved config + live state it re-reads. */
export interface SectionBuildContext {
  page: TrustPageRow;
  asOf: Date;
  partnerName: string;
  config: TrustPublishedConfigResolved;
  /** Exactly as they will appear in the payload (visibility already demoted to the more restrictive value). */
  documents: TrustPagePublicPayload['documents'];
}

export type SectionBlocks = Pick<TrustPagePublicPayload, 'declaredControls' | 'subprocessors' | 'faq' | 'history' | 'frameworks' | 'access'>;
