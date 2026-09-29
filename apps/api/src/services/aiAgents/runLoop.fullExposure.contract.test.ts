/**
 * #7427 contract — NO vi.mock. Every runLoop suite mocks `aiAgentSdkTools`
 * wholesale, so none of them can see drift between the `aiTools` registry
 * (which `fullRunToolExposure` walks) and the SDK `tool()` declarations
 * (which `createBreezeMcpServer` registers). This suite pins, against the
 * REAL modules, that the list a full-profile run hands to
 * `createBreezeMcpServer` as `onlyTools` is always accepted — outside
 * production an unknown name throws, so a regression fails here.
 */
import { describe, expect, it } from 'vitest';

import { declaredFullRunToolExposure, fullRunToolExposure } from './runLoop';
import { createBreezeMcpServer, listChatSurfaceToolNames } from '../aiAgentSdkTools';
import type { AuthContext } from '../../middleware/auth';

const noAuth = (): AuthContext => {
  throw new Error('contract test must not invoke tool handlers');
};

describe('full-run exposure vs declared SDK tools (#7427)', () => {
  const allowlists: ReadonlyArray<readonly string[]> = [
    [],
    ['manage_services', 'disk_cleanup:execute', 'manage_alerts:resolve'],
    // Explicitly names registry tools that have no SDK declaration today.
    ['manage_tickets', 'manage_tags', 'manage_processes'],
  ];

  for (const allowlist of allowlists) {
    it(`is accepted as onlyTools by the real createBreezeMcpServer (allowlist ${JSON.stringify(allowlist)})`, () => {
      const exposure = declaredFullRunToolExposure(allowlist);
      expect(exposure.length).toBeGreaterThan(0);
      expect(() => createBreezeMcpServer(noAuth, undefined, undefined, undefined, [], { onlyTools: new Set(exposure) }))
        .not.toThrow();
    });
  }

  it('only drops names the SDK server does not declare — never a declared one', () => {
    const allowlist = ['manage_services'];
    const declared = new Set(listChatSurfaceToolNames());
    const floor = fullRunToolExposure(allowlist);
    expect(declaredFullRunToolExposure(allowlist)).toEqual(floor.filter((name) => declared.has(name)));
    expect(declaredFullRunToolExposure(allowlist)).toEqual(expect.arrayContaining(['query_devices', 'manage_services']));
  });

  // Control: the unfiltered floor is what #7427 reported. While the registry
  // still carries undeclared tools, passing it straight through must throw —
  // proving the not.toThrow assertions above can fail. If every registry
  // tool gets declared, this control goes vacuous and is skipped.
  it('control: the unfiltered floor is rejected while undeclared registry tools exist', () => {
    const declared = new Set(listChatSurfaceToolNames());
    const floor = fullRunToolExposure([]);
    const undeclared = floor.filter((name) => !declared.has(name));
    if (undeclared.length === 0) return;
    expect(() => createBreezeMcpServer(noAuth, undefined, undefined, undefined, [], { onlyTools: new Set(floor) }))
      .toThrow(/onlyTools referenced unknown tool name/);
  });
});
