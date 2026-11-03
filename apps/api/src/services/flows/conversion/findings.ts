/**
 * Tool Catalog W06 (#5221) Task A7 — building conversion findings. A finding's
 * severity is its code's (FLOW_CONVERSION_FINDING_SEVERITY) unless the map row
 * says otherwise (`partner_wide_org_set_differs` is a blocker above the
 * 500-org fan-out). `detail` carries ids and field names only — never a
 * script body, a command, a message text or a secret — and is clipped to 500.
 */
import {
  FLOW_CONVERSION_FINDING_DETAIL_MAX,
  FLOW_CONVERSION_FINDING_SEVERITY,
  type FlowConversionFinding,
  type FlowConversionFindingCode,
  type FlowConversionFindingSeverity,
} from '@breeze/shared';

export function finding(
  code: FlowConversionFindingCode,
  actionIndex: number | null,
  detail: string,
  severity: FlowConversionFindingSeverity = FLOW_CONVERSION_FINDING_SEVERITY[code],
): FlowConversionFinding {
  return { code, severity, actionIndex, detail: detail.slice(0, FLOW_CONVERSION_FINDING_DETAIL_MAX) };
}

/** Deterministic order: automation-level first, then by action, then by code; duplicates collapse. */
export function sortFindings(findings: readonly FlowConversionFinding[]): FlowConversionFinding[] {
  const seen = new Set<string>();
  const out: FlowConversionFinding[] = [];
  for (const f of findings) {
    const key = `${f.actionIndex ?? -1}|${f.code}|${f.severity}|${f.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out.sort((a, b) => (a.actionIndex ?? -1) - (b.actionIndex ?? -1) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}
