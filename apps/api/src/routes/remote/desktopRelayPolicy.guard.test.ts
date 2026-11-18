import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// OD9: while a device is isolated the server must never hand out STUN. Every
// route that hands ICE servers to a viewer or an agent goes through
// resolveDesktopIcePlan; a direct getIceServers( call in route code would
// silently bypass relay-only.
const ROUTES_DIR = join(__dirname, '..');
const ALLOWED = new Set(['remote/desktopRelayPolicy.ts', 'remote/helpers.ts']);

function routeSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeSources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe('desktop ICE hand-out goes through resolveDesktopIcePlan', () => {
  it('has no direct getIceServers( call in route code', () => {
    const offenders = routeSources(ROUTES_DIR)
      .map((path) => relative(ROUTES_DIR, path))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => /\bgetIceServers\s*\(/.test(readFileSync(join(ROUTES_DIR, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
