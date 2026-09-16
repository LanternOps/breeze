/**
 * Canonical shape of the Threat Detection Review report's `summary` snapshot
 * (#5784 W02). Single-sourced: the API produces it with `satisfies`, the shared
 * PDF renderer and the web preview consume it, and it is persisted in
 * report_runs.result — so EVERY field is optional and a legacy snapshot must
 * still render. Mirrors hardwareLifecycleReport.ts.
 *
 * Nulls are load-bearing. `incidents.opened: null` means UNMEASURED (no active
 * Huntress integration, or the period predates the first sync), never zero. A
 * report that prints "0 incidents" when Huntress was never connected is a lie
 * the customer will act on.
 */

/** Per-source availability, printed on the cover and machine-readable. */
export type ThreatSourceStatus = 'ok' | 'not_connected' | 'never_synced' | 'stale';

/**
 * The window the artifact ACTUALLY covers, which is not always the period.
 * Huntress's first sync fetches 24 hours only and later runs resume from
 * `lastSyncAt - 60s`, so a period that begins before the integration was
 * connected — or spans a sync outage — is covered in part.
 */
export type ThreatCoverage = {
  /** Occurrence period (ISO dates), or the config date range for an ad-hoc run. */
  periodStart?: string;
  periodEnd?: string;
  /** What the data actually spans. `coveredFrom > periodStart` means a gap. */
  coveredFrom?: string | null;
  coveredTo?: string | null;
  /** Generation ran at this instant. On a due-day run it PRECEDES periodEnd. */
  generatedAt?: string;
  sourceStatus?: ThreatSourceStatus;
  /** `huntress_integrations.last_sync_at` / `last_sync_status`. */
  lastSyncAt?: string | null;
  lastSyncStatus?: string | null;
  /** Incidents excluded because device_id is NULL under a restricted authority. */
  unattributableExcluded?: number;
  /** Incidents beyond `topIncidents`, disclosed rather than silently dropped. */
  withheld?: number;
  /** One human sentence naming every gap above. Rendered verbatim. */
  note?: string;
  /**
   * Whether the run was configured to look for detections carried in from
   * earlier periods. `false` means the section was deliberately switched off,
   * which is NOT the same as `incidents.carriedIn: null` meaning "we could not
   * measure it" — without this the two are indistinguishable and a renderer
   * shows a config choice as a data gap. Absent on a legacy snapshot, which
   * renderers must treat as "included" (the default).
   */
  carriedInIncluded?: boolean;
};

export type ThreatIncidentRow = {
  id: string;
  reportedAt: string;
  hostname: string | null;
  severity: string | null;
  category: string | null;
  title: string | null;
  status: string | null;
  resolvedAt: string | null;
  /** Huntress's normalized remediation text. The raw `details` jsonb is NEVER
   *  rendered — it is excludedOpen in the export policy for the same reason. */
  recommendation: string | null;
  /** True when this incident opened before periodStart and is still unresolved. */
  carriedIn?: boolean;
};

export type ThreatDetectionSummary = {
  orgId?: string;
  orgName?: string | null;
  generatedAt?: string;
  coverage?: ThreatCoverage;
  /** null = unmeasured. */
  agentCoverage?: {
    huntressAgents: number | null;
    breezeDevices: number | null;
    agentsOffline: number | null;
    devicesWithoutAgent: number | null;
  };
  incidents?: {
    opened: number | null;
    resolved: number | null;
    bySeverity: Record<string, number> | null;
    byStatus: Record<string, number> | null;
    meanResolveHours: number | null;
    medianResolveHours: number | null;
    carriedIn: number | null;
  };
  rows?: ThreatIncidentRow[];
  /** Short sentences the renderer prints verbatim. */
  dataGaps?: string[];
};
