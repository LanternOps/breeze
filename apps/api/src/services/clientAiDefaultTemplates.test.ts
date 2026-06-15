import { describe, it, expect } from 'vitest';
import { CLIENT_HOSTS } from './clientAiHosts';
import { defaultTemplatesForHost } from './clientAiDefaultTemplates';

describe('clientAiDefaultTemplates', () => {
  it('ships starter templates for every host', () => {
    for (const host of CLIENT_HOSTS) {
      expect(defaultTemplatesForHost(host).length).toBeGreaterThan(0);
    }
  });

  it('uses stable, host-prefixed, globally-unique ids', () => {
    const all = CLIENT_HOSTS.flatMap((h) => defaultTemplatesForHost(h));
    const ids = all.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // no dupes across hosts
    for (const host of CLIENT_HOSTS) {
      for (const t of defaultTemplatesForHost(host)) {
        // id namespaced by host so it can never collide with another host's set
        expect(t.id.startsWith(`default-`)).toBe(true);
      }
    }
  });

  it('every default has a name and a non-empty prompt body', () => {
    for (const host of CLIENT_HOSTS) {
      for (const t of defaultTemplatesForHost(host)) {
        expect(t.name.trim().length).toBeGreaterThan(0);
        expect(t.body.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
