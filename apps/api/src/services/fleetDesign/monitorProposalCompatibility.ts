/**
 * Fleet Design reports generated before W05c2 (#6371) proposed legacy alert
 * rules (`conditions: [...]`, optional `sourceTemplateId`). They stay readable —
 * the viewer only needs name/severity/rationale — but the apply writer now
 * creates monitor definitions, and silently translating an approved legacy
 * condition array into a monitor would change what was approved. So a SELECTED
 * legacy rule proposal blocks apply and the operator regenerates the report.
 *
 * A rule is monitor-shaped when it carries a string `kind` and an object
 * `condition`; anything else is legacy. Only selected refs are reported, so a
 * historical report can still apply its functions, watches and scripts.
 */
export function legacySelectedMonitorRefs(
  sections: ReadonlyArray<{ functionKey: string; alertRules: readonly unknown[] }>,
  selected: readonly string[],
): string[] {
  const selectedSet = new Set(selected);
  return sections.flatMap((section) => section.alertRules.flatMap((rule, index) => {
    const ref = `monitoring:${section.functionKey}:rule:${index}`;
    if (!selectedSet.has(ref)) return [];
    const value = rule as { kind?: unknown; condition?: unknown } | null;
    const monitorShaped = typeof value?.kind === 'string'
      && typeof value.condition === 'object' && value.condition !== null;
    return monitorShaped ? [] : [ref];
  }));
}
