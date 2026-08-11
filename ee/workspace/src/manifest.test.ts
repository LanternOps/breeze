import manifest from '../manifest.json';
import { assertManifestConformance } from '@breeze/extension-testkit';
import { describe, expect, it } from 'vitest';

describe('Workspace manifest', () => {
  it('conforms to the supported v1 contracts', () => {
    expect(assertManifestConformance(manifest)).toEqual({ ok: true, issues: [] });
  });

  // A capability the code uses but the manifest omits is invisible to
  // assertManifestConformance, which validates the manifest in isolation and
  // cannot see code. A host that provisions runtime facilities from the granted
  // capability set would then hand this extension no secrets and no audit sink:
  // encryptForColumn throws on the first SMB credential write, and audit
  // silently no-ops. Each entry below is pinned to its call site so a capability
  // cannot be dropped from the manifest while the code still depends on it.
  it.each([
    ['server.routes.v1', 'registrar.mountRoute in src/index.ts'],
    ['server.agent-routes.v1', 'the /agent sub-app in src/routes/agent.ts'],
    ['server.db.rls.v1', 'context.db via asWorkspaceDatabase in src/hostTypes.ts'],
    ['server.secrets.v1', 'context.secrets.encryptForColumn in src/services/credentialService.ts'],
    ['server.audit.v1', 'context.audit in src/routes/agent.ts and src/routes/sources.ts'],
    ['web.pages.v1', 'manifest.web.pages'],
    ['web.navigation.v1', 'manifest.web.navigation'],
    ['web.slots.v1', 'manifest.web.slots'],
  ])('declares %s, required by %s', (capability) => {
    expect(manifest.requires.capabilities).toContain(capability);
  });

  // NOTE (ee/workspace import): the legacy breeze-extension.json manifest
  // is not carried into the monorepo — the built-in host path is v1-only
  // (manifest.json) — so the parity check that used to compare it against
  // manifest.json was dropped here.

  it('declares the page and device slot under the Workspace namespace', () => {
    expect(manifest.web.pages[0].path).toBe('/extensions/workspace/sources');
    expect(manifest.web.slots[0]).toMatchObject({
      slot: 'device.detail.tabs', contractVersion: 1, element: 'workspace-device-index',
    });
  });
});
