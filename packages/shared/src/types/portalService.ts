import type { TileStatus } from './portalVisibility';

/** Where a row on the Service page came from. Spec §8 keeps these discriminated
 *  so a future Projects module adds 'project' / 'project_milestone' arms to the
 *  same page instead of a second page. */
export type PortalServiceGroupSource = 'contract' | 'standalone';
export type PortalKeyDateSource = 'key_date' | 'contract_end';

export type PortalDeliverableCadence =
  | 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'one_time';

/** Customer-facing rollup of a deliverable's current standing. */
export type PortalDeliverableStatus = 'on_track' | 'due_soon' | 'late' | 'missed';

/**
 * Customer-facing occurrence state. `awaiting_evidence` is deliberately ABSENT:
 * it means the MSP resolved its internal ticket but has not attached the
 * artifact, which is a workflow detail of the MSP, not a fact about the
 * customer's service. It maps to 'in_progress' (spec D10: curated delivery
 * records only, never the ticket behind them).
 */
export type PortalOccurrenceStatus =
  | 'scheduled' | 'in_progress' | 'delivered' | 'missed' | 'waived';

/** What the customer can actually open for a delivery. */
export type PortalArtifactState = 'attached' | 'report' | 'none' | 'held_by_msp';

export interface PortalEvidenceRef {
  kind: 'document' | 'report_run';
  /** Set for kind 'document'; download at /api/v1/portal/documents/<id>/content. */
  documentId: string | null;
  /** Set for kind 'report_run'; download at /api/v1/portal/reports/runs/<id>/pdf. */
  reportRunId: string | null;
  title: string;
  createdAt: string;
}

export interface PortalDeliveryRecord {
  at: string;
  late: boolean;
  note: string | null;
  artifactState: PortalArtifactState;
  evidence: PortalEvidenceRef[];
}

export interface PortalDeliverableDto {
  id: string;
  name: string;
  description: string | null;
  cadence: PortalDeliverableCadence;
  artifactRequired: boolean;
  lastDelivered: PortalDeliveryRecord | null;
  nextDue: string | null;
  status: PortalDeliverableStatus;
}

export interface PortalServiceGroupDto {
  source: PortalServiceGroupSource;
  contract: { id: string; name: string } | null;
  deliverables: PortalDeliverableDto[];
}

export interface PortalKeyDateDto {
  source: PortalKeyDateSource;
  id: string;
  label: string;
  kind: string;
  date: string;
  notes: string | null;
}

export interface PortalServiceOverviewDto {
  asOf: string;
  timezone: string;
  groups: PortalServiceGroupDto[];
  keyDates: PortalKeyDateDto[];
}

export interface PortalOccurrenceDto {
  id: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  dueAt: string;
  rescheduled: boolean;
  status: PortalOccurrenceStatus;
  deliveredAt: string | null;
  late: boolean;
  note: string | null;
  artifactState: PortalArtifactState;
  evidence: PortalEvidenceRef[];
}

export interface PortalOccurrencesDto {
  asOf: string;
  timezone: string;
  deliverable: { id: string; name: string; cadence: PortalDeliverableCadence };
  occurrences: PortalOccurrenceDto[];
}

export type PortalDocumentCategory =
  | 'baseline' | 'runbook' | 'policy' | 'evidence' | 'report' | 'export' | 'other';

export interface PortalDocumentDto {
  id: string;
  title: string;
  description: string | null;
  category: PortalDocumentCategory;
  contentType: string;
  byteSize: number;
  originalFilename: string;
  createdAt: string;
}

export interface PortalDocumentGroupDto {
  category: PortalDocumentCategory;
  documents: PortalDocumentDto[];
}

export interface PortalDocumentsDto {
  asOf: string;
  timezone: string;
  groups: PortalDocumentGroupDto[];
}

/** Dashboard tile (spec §8): 90-day delivery record plus the next due item. */
export interface ServiceTileDto {
  status: TileStatus;
  windowDays: 90;
  deliveredOnTime: number | null;
  deliveredLate: number | null;
  missed: number | null;
  nextDue: { name: string; dueAt: string } | null;
  asOf: string;
}
