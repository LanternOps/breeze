/**
 * Subtitle line for an org row on the Systems screen (#5115).
 *
 * Pure module so the plural/priority rules stay unit-testable without a
 * component runtime. Offline takes priority over open issues when both are
 * present — an offline device is the more urgent signal, and showing both
 * counts in one short line reads as cluttered on a list row.
 */
export function orgRowSubtitle(input: {
  deviceCount: number;
  offlineCount: number;
  issueCount: number;
}): string {
  const deviceLabel = `${input.deviceCount} ${input.deviceCount === 1 ? 'device' : 'devices'}`;
  if (input.offlineCount > 0) {
    return `${deviceLabel} · ${input.offlineCount} offline`;
  }
  if (input.issueCount > 0) {
    return `${deviceLabel} · ${input.issueCount} ${input.issueCount === 1 ? 'issue' : 'issues'}`;
  }
  return `${deviceLabel}, healthy`;
}
