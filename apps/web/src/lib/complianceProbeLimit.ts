/**
 * Strix (PR #12184): an org's agents collect at most 256 registry and 256 config
 * values for compliance checks. A check past that limit is never read, so the
 * API stores it as not assessed (`passed: null`, `data.reason: 'probe_cap'`)
 * and, when nothing else in the rule set failed, the row's status is `pending`.
 * That must not read as "not evaluated yet", so the compliance tables show
 * "Not collected (probe limit)" for such a row.
 */
export function hasProbeLimitNotCollected(details: unknown): boolean {
  if (!details || typeof details !== 'object') return false;
  const ruleResults = (details as { ruleResults?: unknown }).ruleResults;
  if (!Array.isArray(ruleResults)) return false;
  return ruleResults.some((result) => {
    if (!result || typeof result !== 'object') return false;
    const { passed, data } = result as { passed?: unknown; data?: unknown };
    return passed === null
      && !!data && typeof data === 'object'
      && (data as { reason?: unknown }).reason === 'probe_cap';
  });
}
