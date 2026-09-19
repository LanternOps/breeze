import { z } from 'zod';

export interface SoftwareInventoryItem {
  name: string;
  version?: string;
  vendor?: string;
  installDate?: string;
  installLocation?: string;
  uninstallString?: string;
  fileHash?: string;
  hashAlgorithm?: string;
}

export type SoftwareInventoryCompleteness = 'complete' | 'partial' | 'failed';

export interface SoftwareInventoryObservationV2 {
  schemaVersion: 2;
  observationId: string;
  collectorVersion: string;
  observedAt: string;
  completeness: SoftwareInventoryCompleteness;
  expectedSources: string[];
  succeededSources: string[];
  failedSources: Array<{ source: string; code: string }>;
  truncated: boolean;
  itemCount: number;
  items: SoftwareInventoryItem[];
}

export interface LegacySoftwareInventoryReport {
  software: SoftwareInventoryItem[];
}

export const softwareInventoryItemSchema = z.object({
  name: z.string().min(1).max(500),
  version: z.string().max(100).optional(),
  vendor: z.string().max(200).optional(),
  installDate: z.string().max(64).optional(),
  installLocation: z.string().max(4096).optional(),
  uninstallString: z.string().max(8192).optional(),
  fileHash: z.string().max(128).optional(),
  hashAlgorithm: z.string().max(10).optional(),
}).strict();

const sourceNameSchema = z.string().min(1).max(100);
const sourceFailureSchema = z.object({
  source: sourceNameSchema,
  code: z.string().min(1).max(64),
}).strict();

const sourceNamesSchema = z.array(sourceNameSchema).max(64);

export const legacySoftwareInventoryReportSchema = z.object({
  software: z.array(softwareInventoryItemSchema).max(10_000),
}).strict();

export const softwareInventoryObservationV2Schema = z.object({
  schemaVersion: z.literal(2),
  observationId: z.string().uuid(),
  collectorVersion: z.string().min(1).max(64),
  observedAt: z.string().datetime({ offset: true }),
  completeness: z.enum(['complete', 'partial', 'failed']),
  expectedSources: sourceNamesSchema.min(1),
  succeededSources: sourceNamesSchema,
  failedSources: z.array(sourceFailureSchema).max(64),
  truncated: z.boolean(),
  itemCount: z.number().int().min(0).max(5_000),
  items: z.array(softwareInventoryItemSchema).max(5_000),
}).strict().superRefine((report, ctx) => {
  const expected = new Set(report.expectedSources);
  const succeeded = new Set(report.succeededSources);
  const failedNames = report.failedSources.map((failure) => failure.source);
  const failed = new Set(failedNames);

  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (expected.size !== report.expectedSources.length) issue('expectedSources must be unique');
  if (succeeded.size !== report.succeededSources.length) issue('succeededSources must be unique');
  if (failed.size !== failedNames.length) issue('failedSources source names must be unique');
  if ([...succeeded].some((source) => failed.has(source))) issue('succeeded and failed sources must be disjoint');
  if ([...succeeded, ...failed].some((source) => !expected.has(source))) issue('reported source is not expected');
  if ([...expected].some((source) => !succeeded.has(source) && !failed.has(source))) issue('every expected source must be accounted for');
  if (report.itemCount !== report.items.length) issue('itemCount must equal items length');

  if (report.completeness === 'complete') {
    if (report.truncated || failed.size > 0 || succeeded.size !== expected.size) {
      issue('complete observations require all sources to succeed without truncation');
    }
  } else if (report.completeness === 'partial') {
    if (succeeded.size === 0 || (!report.truncated && failed.size === 0)) {
      issue('partial observations require a successful source and failure or truncation');
    }
  } else if (succeeded.size > 0 || failed.size === 0) {
    issue('failed observations require no successful source and at least one failed source');
  }
});

export const softwareInventoryReportSchema = z.union([
  softwareInventoryObservationV2Schema,
  legacySoftwareInventoryReportSchema,
]);
