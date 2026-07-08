/*
 * Regenerates cpe-translations.json from FleetDM's cpe_translations.json.
 * Manual tool — NOT imported at runtime. Run: pnpm tsx scripts/regen-cpe-data.ts
 * Requires network. Preserves the committed starter entries (union, dedup by name).
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FLEET_URL =
  'https://raw.githubusercontent.com/fleetdm/fleet/main/server/vulnerabilities/nvd/cpe_translations.json';
const OUT = join(__dirname, '../src/services/__fixtures__/cpe-translations.json');

interface FleetEntry {
  software?: { name?: string[]; source?: string[] };
  filter?: { product?: string[]; vendor?: string[]; skip?: boolean };
}

async function main(): Promise<void> {
  const upstream = (await (await fetch(FLEET_URL)).json()) as FleetEntry[];
  const existing = JSON.parse(readFileSync(OUT, 'utf8')) as Array<{ name: string; vendor: string; product: string }>;
  const byName = new Map(existing.map((e) => [e.name, e]));

  for (const entry of upstream) {
    const names = entry.software?.name ?? [];
    const product = entry.filter?.product?.[0];
    const vendor = entry.filter?.vendor?.[0];
    if (!product || !vendor || entry.filter?.skip) continue;
    for (const name of names) {
      if (name.startsWith('/')) continue;                 // skip regex-pattern entries
      if (!byName.has(name)) byName.set(name, { name, vendor, product });
    }
  }
  const merged = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(OUT, JSON.stringify(merged, null, 2) + '\n');
  console.log(`wrote ${merged.length} translation entries`);
}
main().catch((e) => { console.error(e); process.exit(1); });
