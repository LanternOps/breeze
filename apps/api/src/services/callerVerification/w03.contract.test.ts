/**
 * W03 (#6354 / #6357) reachability contract: the link tier, public routes and
 * mailbox read are actually wired, and public/delivery code never carries
 * token material into a response, log or audit. Source-level on purpose —
 * each assertion pins a seam a refactor could silently drop.
 */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

it('mounts the public router once, unauthenticated, beside Quick Support', () => {
  const index = read('../../index.ts');
  expect(index.match(/api\.route\('\/verify', callerVerifyPublicRoutes\)/g)).toHaveLength(1);
  const route = read('../../routes/callerVerifyPublic.ts');
  expect(route).toContain('applyDecision(');
  expect(route).toContain('withSystemDbAccessContext(');
  expect(route).toContain("'no-store, private'");
  expect(route).not.toContain('authMiddleware');
  // Flag check precedes every Redis/DB touch in the shared middleware.
  const middleware = route.slice(route.indexOf("callerVerifyPublicRoutes.use('*'"), route.indexOf('async function budgetRefusal'));
  expect(middleware.indexOf('isCallerVerificationEnabled()')).toBeGreaterThan(-1);
  expect(middleware.indexOf('isCallerVerificationEnabled()')).toBeLessThan(middleware.indexOf('getRedis()'));
});

it('wires sms/email ports, the mailbox port and the gate reader', () => {
  const ports = read('./ports.ts');
  expect(ports).toContain("import('./linkPorts')");
  expect(ports).toContain("import('./mailboxes')");
  expect(read('./gate.ts')).toContain('withMailboxReader(input.technicianUserId');
  expect(read('../../routes/callerVerification.ts')).toContain('caller-verification:start:');
});

it('delivers SMS through Messaging (never the Verify code path) and email on the partner support stream', () => {
  const delivery = read('./deliverers/link.ts');
  expect(delivery).toContain("getTwilioService('messaging')");
  expect(delivery).not.toMatch(/sendVerificationCode|checkVerificationCode/);
  expect(delivery).toContain("purpose: 'security.caller_verification_link'");
  expect(delivery).toContain('applyDecision(');
});

it('the public card projection carries no verifier material or identifiers', () => {
  const lookup = read('./publicLookup.ts');
  const projection = lookup.slice(lookup.indexOf('export function toPublicCard'), lookup.indexOf('export interface LinkDelivery'));
  expect(projection.length).toBeGreaterThan(100);
  for (const forbidden of ['challengeTokenHash', 'matchValue', 'decoyValues', 'sealedLinkToken', 'orgId', 'contactId', 'destination', 'row.id']) {
    expect(projection, forbidden).not.toContain(forbidden);
  }
  const lookupSelect = lookup.slice(lookup.indexOf('export async function lookupPublicToken'), lookup.indexOf('export function isLiveCard'));
  expect(lookupSelect).not.toMatch(/matchValue|decoyValues|sealedLinkToken/);
});

it('never logs a token, URL or sealed blob in delivery or the public route', () => {
  for (const file of ['./deliverers/link.ts', '../../routes/callerVerifyPublic.ts', './linkPorts.ts']) {
    const source = read(file);
    for (const call of source.match(/console\.(log|warn|error)\([^;]*;/gs) ?? []) {
      expect(call, `${file}: ${call}`).not.toMatch(/\btoken\b|\burl\b|sealed/i);
    }
  }
});
