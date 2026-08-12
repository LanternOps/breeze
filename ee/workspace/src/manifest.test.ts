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

  /**
   * NOTE (ee/workspace import): the legacy `breeze-extension.json` manifest was
   * dropped by the built-in merge, so the two tests that pinned it — the
   * semantic-equivalence check against manifest.json, and the assertions that
   * it declares `clientSurfaces: [{ pathPrefix: '/client' }]` and the
   * `workspace-filing-card` `clientPanels` row — were removed here. The
   * built-in path carries the one legacy flag it still needs (`helperRoutes`)
   * as an explicit field on the `BUILTINS` entry in
   * apps/api/src/extensions/builtinRegistry.ts instead of reading a file.
   *
   * The client surface itself has NO core-side declaration in this repo yet:
   * core's generic client-ai proxy, and the loader support that carries
   * `clientSurfaces`/`clientPanels`, are unmerged. `/client/*` therefore mounts
   * under the extension gateway and fails closed (clientGate demands an
   * organization-scoped context) until that platform work lands.
   *
   * The negative halves below still hold and are kept: the FROZEN, `.strict()`
   * v1 wire schema rejects both keys, which is why they never rode
   * manifest.json in the first place.
   */
  it('keeps the frozen v1 manifest free of the not-yet-standardized client key', () => {
    expect(manifest).not.toHaveProperty('clientSurfaces');
    expect(assertManifestConformance({ ...manifest, clientSurfaces: [{ pathPrefix: '/client' }] }))
      .toMatchObject({ ok: false });
  });

  it('keeps the frozen v1 manifest free of the not-yet-standardized clientPanels key', () => {
    expect(manifest).not.toHaveProperty('clientPanels');
    expect(assertManifestConformance({
      ...manifest,
      clientPanels: [{ host: 'outlook', surface: 'message-read', element: 'workspace-filing-card', module: 'web/index.js' }],
    })).toMatchObject({ ok: false });
  });

  it('declares the page and device slot under the Workspace namespace', () => {
    expect(manifest.web.pages[0].path).toBe('/extensions/workspace/sources');
    expect(manifest.web.slots[0]).toMatchObject({
      slot: 'device.detail.tabs', contractVersion: 1, element: 'workspace-device-index',
    });
  });

  it('contributes the dashboard page and its navigation entry', () => {
    expect(manifest.web.pages).toContainEqual({
      id: 'dashboard',
      path: '/extensions/workspace/dashboard',
      element: 'workspace-dashboard',
    });
    expect(manifest.web.navigation).toContainEqual({
      id: 'dashboard',
      label: 'Workspace Dashboard',
      path: '/extensions/workspace/dashboard',
      order: 50,
    });
  });
});
