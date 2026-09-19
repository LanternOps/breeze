import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * #3987: the API has accepted `{ uninstallAgent }` on DELETE /devices/:id since
 * #4001, but no web caller sent it — every Remove left the agent installed and
 * heartbeating into a 403. Four surfaces went through the service layer (which
 * now always sends a body) and one, PossibleReplacementBanner, issued its own
 * bodyless DELETE. Code review would not catch a fifth: this does.
 */
describe('every Remove sends the agent choice (#3987)', () => {
  it('no component issues a bodyless DELETE /devices/:id', () => {
    const offenders: string[] = [];
    for (const file of walk(join(root, 'components'))) {
      const src = readFileSync(file, 'utf8');
      // fetchWithAuth(`/devices/${x}`, { method: 'DELETE' }) with no `body:` in the same call
      const re = /fetchWithAuth\(\s*`\/devices\/\$\{[^}]+\}`\s*,\s*\{([^}]*)\}\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (/method:\s*['"]DELETE['"]/.test(m[1]) && !/body:/.test(m[1])) offenders.push(file.replace(root, ''));
      }
    }
    expect(offenders, 'Route these through decommissionDevice(id, { uninstallAgent }) or add the JSON body').toEqual([]);
  });
});
