/**
 * Caller verification W05 (#6354) wiring contract: every site that can send a
 * protected Microsoft 365 identity mutation calls the dispatch guard, and the
 * release path consumes. A source reference alone proves neither ordering nor
 * zero HTTP writes — the behavioural suites (m365DirectGraph, writeActionService,
 * aiToolsM365, m365ToolsHeadless, revalidateRelease, the live enforcement
 * integration suite) prove those. This file fails loudly when a new backend
 * branch or a refactor drops the guard from one of the known sites.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The text from `marker` to the next sibling case / top-level declaration. */
function block(text: string, marker: string): string {
  const start = text.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThanOrEqual(0);
  const stops = ['\n    case ', '\nexport ', '\nasync function ', '\nfunction ']
    .map((stop) => text.indexOf(stop, start + marker.length))
    .filter((index) => index > start);
  return text.slice(start, stops.length ? Math.min(...stops) : text.length);
}

describe('caller verification enforcement sites', () => {
  it('release revalidation consumes after the core checks', () => {
    const text = source('../actionIntents/revalidateRelease.ts');
    const entry = block(text, 'export async function revalidateApprovedIntentForRelease');
    expect(entry).toMatch(/revalidateApprovedIntentCore\([\s\S]*consumeCallerVerificationForRelease/);
    expect(block(text, 'async function consumeCallerVerificationForRelease')).toContain("mode: 'consume'");
  });

  it.each([
    ['../m365DirectGraph.ts', "case 'disable_user':"],
    ['../m365DirectGraph.ts', "case 'reset_user_password':"],
  ])('%s guards %s before its PATCH', (path, marker) => {
    const body = block(source(path), marker);
    const guard = body.indexOf('prepareCallerDispatch(');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(body).toContain('requireCallerVerification');
    expect(guard).toBeLessThan(body.indexOf("'PATCH'"));
  });

  it('control-plane write service guards both protected actions before the executor call', () => {
    const text = source('../m365ControlPlane/writeActionService.ts');
    const start = text.indexOf('export async function executeM365WriteActionByOrg');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = text.slice(start, text.indexOf('\nexport ', start + 1));
    const guard = body.indexOf("case 'm365.user.disable':\n    case 'm365.user.reset_password':\n      await prepareCallerDispatch(");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(body).toContain('requireCallerVerification');
    expect(guard).toBeLessThan(body.indexOf('client.executeWriteAction('));
  });

  it('Delegant broker path guards both protected tools before invokeDelegantTool', () => {
    const body = block(source('../aiToolsM365.ts'), 'async function call(');
    const guard = body.indexOf("if (toolName === 'disable_user' || toolName === 'reset_user_password') {\n    // Caller verification");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(body.slice(guard)).toMatch(/prepareCallerDispatch\([\s\S]*requireCallerVerification[\s\S]*invokeDelegantTool\(/);
  });

  it('creation checks the caller before the creation transaction', () => {
    const text = source('../actionIntents/intentService.ts');
    const check = text.indexOf("mode: 'check'");
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(text.indexOf('targetEntraOid: callerTarget?.entraOid ?? null'));
  });
});
