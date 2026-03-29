import { z } from 'zod';

export const incidentSeveritySchema = z.enum(['p1', 'p2', 'p3', 'p4']);
export const incidentStatusSchema = z.enum(['detected', 'analyzing', 'contained', 'recovering', 'closed']);
export const incidentEvidenceTypeSchema = z.enum(['file', 'log', 'screenshot', 'memory', 'network']);
export const incidentActorSchema = z.enum(['user', 'brain', 'system']);
export const incidentActionStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']);
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;
export type IncidentActionStatus = z.infer<typeof incidentActionStatusSchema>;

export const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

export const createIncidentSchema = z.object({
  orgId: z.string().uuid().optional(),
  title: z.string().min(3).max(500),
  classification: z.string().min(2).max(40),
  severity: incidentSeveritySchema,
  summary: z.string().max(10_000).optional(),
  relatedAlerts: z.array(z.string().uuid()).max(1000).optional(),
  affectedDevices: z.array(z.string().uuid()).max(5000).optional(),
  assignedTo: z.string().uuid().optional(),
  detectedAt: z.string().datetime({ offset: true }).optional(),
  status: z.enum(['detected', 'analyzing']).optional(),
});

export const listIncidentsSchema = z.object({
  orgId: z.string().uuid().optional(),
  status: incidentStatusSchema.optional(),
  severity: incidentSeveritySchema.optional(),
  classification: z.string().max(40).optional(),
  assignedTo: z.string().uuid().optional(),
  startDate: z.string().datetime({ offset: true }).optional(),
  endDate: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(250).optional(),
});

export const containIncidentSchema = z.object({
  actionType: z.string().min(2).max(40),
  description: z.string().min(3).max(10_000),
  executedBy: incidentActorSchema.optional(),
  status: incidentActionStatusSchema.optional(),
  result: z.record(z.unknown()).optional(),
  reversible: z.boolean().optional(),
  approvalRef: z.string().max(128).optional(),
  executedAt: z.string().datetime({ offset: true }).optional(),
});

export const addEvidenceSchema = z.object({
  evidenceType: incidentEvidenceTypeSchema,
  description: z.string().max(10_000).optional(),
  collectedAt: z.string().datetime({ offset: true }).optional(),
  collectedBy: incidentActorSchema.optional(),
  hash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  contentBase64: z.string().max(5_000_000).optional(),
  storagePath: z.string().min(1).max(5000),
  metadata: z.record(z.unknown()).optional(),
});

export const closeIncidentSchema = z.object({
  summary: z.string().min(3).max(15_000),
  lessonsLearned: z.string().max(15_000).optional(),
  resolvedAt: z.string().datetime({ offset: true }).optional(),
});

export const ALLOWED_STATUS_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  detected: ['analyzing', 'contained'],
  analyzing: ['contained', 'recovering'],
  contained: ['recovering', 'closed'],
  recovering: ['contained', 'closed'],
  closed: [],
};

export const HIGH_RISK_CONTAINMENT_ACTIONS = new Set([
  'network_isolation',
  'account_disable',
  'usb_block',
  'process_kill',
]);

export const ALLOWED_EVIDENCE_STORAGE_SCHEMES = new Set(
  (process.env.EVIDENCE_STORAGE_ALLOWED_SCHEMES ?? 's3,gs,r2,azblob,immutable,https')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
);
export const EVIDENCE_HASH_ALGORITHM = 'sha256';
