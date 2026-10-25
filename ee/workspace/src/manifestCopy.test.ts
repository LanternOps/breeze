import manifest from '../manifest.json';
import { describe, expect, it } from 'vitest';

// Product decision (spec 17.2, contract A35): the extension is labelled "Wisp"
// in user-visible copy only. Technical identity stays "workspace" because the
// SDK requires <manifest.name>_ table prefixes and the migration ledger is keyed
// by manifest name.
describe('manifest copy vs identity', () => {
  it('keeps the technical identity unchanged', () => {
    expect(manifest.name).toBe('workspace');
    expect(manifest.routeNamespace).toBe('workspace');
    for (const page of manifest.web.pages) expect(page.path).toMatch(/^\/extensions\/workspace\//);
    for (const nav of manifest.web.navigation) expect(nav.path).toMatch(/^\/extensions\/workspace\//);
  });

  it('labels navigation entries as Wisp', () => {
    const labels = Object.fromEntries(manifest.web.navigation.map((n) => [n.id, n.label]));
    expect(labels).toEqual({ sources: 'Wisp Sources', dashboard: 'Wisp Dashboard' });
  });

  it('labels the device tab slot as Wisp', () => {
    expect(manifest.web.slots.map((s) => s.label)).toEqual(['Wisp']);
  });

  it('shows no "workspace" in any navigation or slot label', () => {
    const labels = [...manifest.web.navigation.map((n) => n.label), ...manifest.web.slots.map((s) => s.label)];
    for (const label of labels) expect(label).not.toMatch(/workspace/i);
  });
});
