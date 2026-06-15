// apps/web/src/lib/scopeConfirmMessage.ts
//
// Composes a confirmation message that always names the target scope and count,
// so a tech can never fire a fleet action without seeing WHO it hits. The
// multi-org phrasing is intentionally heavier — acting across customers should
// read as a bigger deal.
export function scopeConfirmMessage({
  action,
  deviceCount,
  orgNames,
}: {
  action: string;
  deviceCount: number;
  orgNames: string[];
}): string {
  const devices = `${deviceCount} device${deviceCount === 1 ? '' : 's'}`;
  if (orgNames.length <= 1) {
    const org = orgNames[0] ?? 'the selected organization';
    return `${action} on ${devices} in ${org}?`;
  }
  return `${action} on ${devices} across ${orgNames.length} organizations (${orgNames.join(', ')})?`;
}
