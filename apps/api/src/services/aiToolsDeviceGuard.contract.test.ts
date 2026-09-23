import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Contract: the DEVICE axis in the AI-tools layer (#6096 D5d).
 *
 * Sibling to `aiTools.deviceAccessSiteScope.contract.test.ts`, which guards the
 * SITE axis. This one guards the exact-device axis, which is what actually
 * bounds a device-bound agent run: `agentAuthContext.ts` pins
 * `auth.allowedDeviceIds` to the run's single device, and the site pin alone
 * admits every SIBLING device in the same site. These are source contracts
 * rather than behavioural tests because the bug class is a COPY — each of the
 * ten `verifyDeviceAccess` implementations is a near-duplicate, and the next
 * one gets written by copying whichever is nearest.
 */
const SERVICES_DIR = __dirname;

const AI_TOOLS_SOURCES = readdirSync(SERVICES_DIR)
  .filter((f) => /^aiTools.*\.ts$/.test(f) && !f.includes('.test.'))
  .sort();

/** The body of each `verifyDeviceAccess` declaration, by brace matching. */
function verifyDeviceAccessBodies(source: string): string[] {
  const bodies: string[] = [];
  const declaration = /async function verifyDeviceAccess\(/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    // The BODY brace, not the `{ device: … }` in the return type: every one of
    // these signatures ends its line with the opening brace.
    const open = source.indexOf('{\n', match.index);
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}' && --depth === 0) break;
    }
    bodies.push(source.slice(open, end + 1));
  }
  return bodies;
}

describe('contract: AI-tools verifyDeviceAccess enforces the exact-device axis first', () => {
  it('finds the verifyDeviceAccess implementations to scan', () => {
    const withHelper = AI_TOOLS_SOURCES.filter(
      (f) => verifyDeviceAccessBodies(readFileSync(join(SERVICES_DIR, f), 'utf8')).length > 0,
    );
    // A drop here means a file was renamed or the helper inlined — re-derive
    // the list rather than lowering the number.
    expect(withHelper.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of AI_TOOLS_SOURCES) {
    const bodies = verifyDeviceAccessBodies(readFileSync(join(SERVICES_DIR, file), 'utf8'));
    if (bodies.length === 0) continue;
    it(`${file}: checks auth.allowedDeviceIds before the first device read`, () => {
      for (const body of bodies) {
        const guard = body.indexOf('auth.allowedDeviceIds');
        expect(guard, `${file}: verifyDeviceAccess must check auth.allowedDeviceIds`)
          .toBeGreaterThanOrEqual(0);
        // Ordering is the whole point: a check placed AFTER the read still
        // returns the right answer but has already read another tenant's
        // device row into the process, and the next copy-paste moves the read
        // above the return.
        const reads = [body.indexOf('db.select'), body.indexOf('db.query')]
          .filter((index) => index >= 0);
        for (const read of reads) {
          expect(guard, `${file}: the allowedDeviceIds check must precede the device read`)
            .toBeLessThan(read);
        }
      }
    });
  }
});

/**
 * `deviceSiteDenied(auth, siteId, deviceId)` applies the device axis only when
 * a device id is passed; omitting it means "this resource has no device axis"
 * (see the helper's own docstring). So a call that HAS a device row in scope
 * and passes only two arguments silently drops the exact-device check.
 *
 * "Has a device row" is defined pragmatically: every call site is 3-argument
 * unless it is listed below. The listed sites resolve a SITE-shaped resource
 * (an alert rule's site target, a device group, a group's requested site) and
 * have no device to name — a 3-argument call there would deny a device-bound
 * run every group and deployment in its own site.
 */
const SITE_ONLY_CALL_SITES: ReadonlyArray<{ file: string; call: string; count: number }> = [
  { file: 'aiToolsFleet.ts', call: 'deviceSiteDenied(auth, rule.targetId)', count: 1 },
  { file: 'aiToolsFleet.ts', call: 'deviceSiteDenied(auth, group?.siteId ?? null)', count: 1 },
  { file: 'aiToolsFleet.ts', call: 'deviceSiteDenied(auth, group.siteId)', count: 2 },
  { file: 'aiToolsFleet.ts', call: 'deviceSiteDenied(auth, (input.siteId as string) ?? null)', count: 1 },
  { file: 'aiToolsFleet.ts', call: 'deviceSiteDenied(auth, existing.siteId)', count: 2 },
];

/** Every `deviceSiteDenied(...)` CALL (not the declaration) in a source file. */
function deviceSiteDeniedCalls(source: string): string[] {
  const calls: string[] = [];
  const needle = 'deviceSiteDenied(';
  for (let idx = source.indexOf(needle); idx !== -1; idx = source.indexOf(needle, idx + 1)) {
    if (/function\s+$/.test(source.slice(Math.max(0, idx - 12), idx))) continue;
    let depth = 0;
    let end = idx + needle.length - 1;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    calls.push(source.slice(idx, end + 1));
  }
  return calls;
}

/** Top-level argument count (commas inside nested parens don't split). */
function argCount(call: string): number {
  const inner = call.slice(call.indexOf('(') + 1, call.lastIndexOf(')'));
  let depth = 0;
  let args = 1;
  for (const ch of inner) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) args++;
  }
  return inner.trim() === '' ? 0 : args;
}

describe('contract: deviceSiteDenied call sites carry the device id', () => {
  const twoArg = new Map<string, string[]>();
  for (const file of AI_TOOLS_SOURCES) {
    const calls = deviceSiteDeniedCalls(readFileSync(join(SERVICES_DIR, file), 'utf8'))
      .filter((call) => argCount(call) < 3);
    if (calls.length > 0) twoArg.set(file, calls);
  }

  it('scans a non-trivial number of call sites', () => {
    const total = AI_TOOLS_SOURCES.reduce(
      (sum, file) => sum + deviceSiteDeniedCalls(readFileSync(join(SERVICES_DIR, file), 'utf8')).length,
      0,
    );
    expect(total).toBeGreaterThan(20);
  });

  it('every two-argument call is a known site-only resource', () => {
    const expected = new Map<string, string[]>();
    for (const entry of SITE_ONLY_CALL_SITES) {
      const list = expected.get(entry.file) ?? [];
      for (let i = 0; i < entry.count; i++) list.push(entry.call);
      expected.set(entry.file, list);
    }
    const normalize = (map: Map<string, string[]>) => Object.fromEntries(
      [...map].map(([file, calls]) => [file, [...calls].sort()]),
    );
    // A new two-argument call fails here. If the resource genuinely has no
    // device axis, add it to SITE_ONLY_CALL_SITES with a one-line reason;
    // otherwise pass the device id.
    expect(normalize(twoArg)).toEqual(normalize(expected));
  });
});
