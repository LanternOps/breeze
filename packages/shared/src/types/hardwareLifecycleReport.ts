/**
 * Canonical shape of the Hardware Lifecycle report's `summary` snapshot.
 * Single-sourced (API produces with `satisfies`, the shared PDF renderer and
 * the web preview consume) and persisted in report_runs.result, so every
 * field is optional — a legacy snapshot must still render. Mirrors
 * postureReport.ts / executiveSummaryReport.ts.
 *
 * Nulls are load-bearing: a device with no purchase date and no active
 * warranty is `replacement: 'unknown'` and `replaceBy: null` — never "new",
 * never "overdue". The report must not claim what it cannot prove (the
 * never-scanned ≠ verified-clean discipline from managementPostureReport).
 */

/** Replacement band, derived ONLY from the replace-by date. */
export type ReplacementStatus = 'supported' | 'due_soon' | 'replace' | 'unknown';

/**
 * OS support status. Conservative on purpose: anything we cannot positively
 * identify is `unclassified`, never `ended`. `na` marks a device with no OS
 * (network/print hardware, manual assets) — it is "other equipment", not a
 * computer, and replacement timelines do not apply.
 */
export type OsSupportStatus = 'supported' | 'ending' | 'ended' | 'unclassified' | 'na';

export type HardwareLifecycleDeviceRow = {
  /** Agent device id or manual asset id. */
  id: string;
  kind: 'device' | 'manual_asset';
  /** What the customer calls it: display name, else hostname, else asset name. */
  name: string;
  hostname?: string | null;
  site?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  /** Cleaned for non-technical readers ("Windows 11 Pro", "macOS 26.3"). */
  os: string;
  osSupport: OsSupportStatus;
  /** YYYY-MM-DD or null. */
  purchaseDate: string | null;
  purchaseDateSource: 'manual' | 'vendor' | null;
  /** YYYY-MM-DD or null. Active-coverage end only matters when > today. */
  warrantyEndDate: string | null;
  /** Years since purchase, one decimal; null when purchase date is unknown. */
  ageYears: number | null;
  /** YYYY-MM-DD or null when neither date gives a defensible answer. */
  replaceBy: string | null;
  replacement: ReplacementStatus;
  /** True when active warranty coverage is what sets replaceBy. */
  warrantyExtended: boolean;
  /** Share of the purchase→replaceBy runway already used, 0..1; null without both dates. */
  lifeUsed: number | null;
};

export type HardwareLifecycleOtherRow = {
  id: string;
  kind: 'device' | 'manual_asset';
  name: string;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  /** Device role / asset type, for the "network and print hardware" phrasing. */
  category?: string | null;
};

export type HardwareLifecycleSummary = {
  org?: { id?: string; name?: string };
  generatedAt?: string;
  /** The replacement age the bands were computed with (config, default 4). */
  replaceAgeYears?: number;
  computers?: {
    total?: number;
    byReplacement?: Partial<Record<ReplacementStatus, number>>;
    byOsSupport?: Partial<Record<Exclude<OsSupportStatus, 'na'>, number>>;
  };
  otherEquipmentCount?: number;
  /** Computers, most urgent first (earliest replaceBy; no-date rows last). */
  rows?: HardwareLifecycleDeviceRow[];
  other?: HardwareLifecycleOtherRow[];
  /** Plain-English staged plan, derived from the bands. No pricing claims. */
  recommendations?: string[];
};
