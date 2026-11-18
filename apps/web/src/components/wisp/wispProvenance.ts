/**
 * Wisp W07 (#9920) — "Wisp for <user>" provenance on run and Operator task
 * detail (spec §13). The API stamps an additive `wisp` block on the run detail
 * and task DTOs (`{ grantId, grantorUserId, grantorName, depth,
 * requestedByRunId }`, null for anything not admitted under a Wisp grant).
 *
 * The block is read structurally rather than through the DTO type so the two
 * detail pages render it the moment the API sends it and render nothing for
 * an older API (field absent) or a malformed block — provenance is a label,
 * and a missing label must never break the page. Only the two fields the
 * label needs are returned.
 */
export interface WispProvenanceView {
  grantorUserId: string;
  /** Null when the grantor's name is not visible to the viewer. */
  grantorName: string | null;
}

export function readWispProvenance(dto: object): WispProvenanceView | null {
  const raw: unknown = (dto as { wisp?: unknown }).wisp;
  if (!raw || typeof raw !== 'object') return null;
  const { grantorUserId, grantorName } = raw as { grantorUserId?: unknown; grantorName?: unknown };
  if (typeof grantorUserId !== 'string' || grantorUserId.length === 0) return null;
  return {
    grantorUserId,
    grantorName: typeof grantorName === 'string' ? grantorName : null,
  };
}

/** The grantor's name, or — when it is not visible — the 8-character id
 *  prefix the detail pages use for bare identifiers. */
export function wispGrantorLabel(p: WispProvenanceView): string {
  const name = p.grantorName?.trim();
  return name ? name : p.grantorUserId.slice(0, 8);
}
