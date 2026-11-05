import type { z } from 'zod';

export type ContainmentField = 'target' | 'proto' | 'ports' | 'label';

// The shared schema's refinements raise code `custom` with no params (the host regex raises
// `invalid_format`), so the message is the only thing that tells them apart. The strings stay English
// there for its other consumers (the API routes and the isolation wire contracts);
// containmentIssueKey.test.ts runs the real schema, so rewording one fails that test.
const REFINEMENT_KEYS = new Map<string, string>([
  ['host must be a DNS name', 'errors.hostInvalid'],
  ['an IP address is a cidr entry, not a host', 'errors.hostIsAddress'],
  ['loopback hostnames are not allowed', 'errors.hostLoopback'],
  ['a /0 permit is not allowed', 'errors.cidrBlanket'],
  ['CIDR must be at least /8 (IPv4) or /32 (IPv6) and exclude loopback and unspecified addresses', 'errors.cidrOutOfBounds'],
  ['ports must be unique', 'errors.portsUnique'],
  ['label must not contain control characters', 'errors.labelControlChars'],
]);

/** The `containmentTab.*` key for a row issue. Never falls through to the schema's own English text. */
export function containmentIssueKey(field: ContainmentField, issue: z.core.$ZodIssue): string {
  if (field === 'proto') return 'protoInvalid';
  const refinement = REFINEMENT_KEYS.get(issue.message);
  if (refinement) return refinement;
  if (issue.code === 'custom') return 'errors.generic';
  if (field === 'ports') return 'portsInvalid';
  if (field === 'label') return 'labelInvalid';
  // A malformed range fails inside the v4/v6 union, whose message is only "Invalid input".
  return issue.code === 'invalid_union' ? 'cidrInvalid' : 'errors.generic';
}
