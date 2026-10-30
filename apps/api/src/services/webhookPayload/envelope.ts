/** Serialize once; the sender signs these exact bytes for either version. */
export function buildWebhookEnvelope(input: {
  version: 1 | 2;
  id: string;
  type: string;
  orgId: string | null;
  timestamp: string;
  data: unknown;
  replayOf: string | null;
}): string {
  if (input.version === 1) {
    return JSON.stringify({ id: input.id, type: input.type, timestamp: input.timestamp, orgId: input.orgId, data: input.data });
  }
  return JSON.stringify({
    id: input.id,
    type: input.type,
    timestamp: input.timestamp,
    orgId: input.orgId,
    schemaVersion: 2,
    replayOf: input.replayOf,
    data: input.data
  });
}
