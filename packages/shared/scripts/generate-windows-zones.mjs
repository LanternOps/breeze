import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
const [windowsPath, aliasesPath, outputPath] = process.argv.slice(2);
if (!windowsPath || !aliasesPath || !outputPath) {
  throw new Error(
    'Usage: node packages/shared/scripts/generate-windows-zones.mjs windowsZones.xml timezone.xml output.json',
  );
}
const decode = (value) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const attributes = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [
      key,
      decode(value),
    ]),
  );
const xml = await readFile(windowsPath, 'utf8');
const aliasXml = await readFile(aliasesPath, 'utf8');
const mapping = new Map();
const set = (iana, windows) => {
  const previous = mapping.get(iana);
  if (previous && previous !== windows)
    throw new Error(`Conflicting Windows mapping: ${iana}`);
  mapping.set(iana, windows);
};
let rows = 0;
for (const match of xml.matchAll(/<mapZone\b[^>]*\/>/g)) {
  const { other, type } = attributes(match[0]);
  if (!other || !type) throw new Error('Malformed mapZone row');
  for (const iana of type.split(/\s+/).filter(Boolean)) set(iana, other);
  rows++;
}
if (rows < 100)
  throw new Error('Input is not the complete CLDR windowsZones.xml');
for (const match of aliasXml.matchAll(/<type\b[^>]*\/>/g)) {
  const { alias, iana } = attributes(match[0]);
  if (!alias) continue;
  const names = [...new Set([...alias.split(/\s+/), ...(iana ? [iana] : [])])];
  const known = new Set(names.map((name) => mapping.get(name)).filter(Boolean));
  if (known.size > 1) throw new Error(`Conflicting timezone aliases: ${alias}`);
  if (known.size === 1) for (const name of names) set(name, [...known][0]);
}
// UTC is a supported API sentinel, not a geographic zone approximation.
set('UTC', 'UTC');
set('Etc/UTC', 'UTC');
const data = {
  cldrVersion: '48.2',
  ianaToWindows: Object.fromEntries(
    [...mapping.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ),
  windowsIds: [...new Set(mapping.values())].sort(),
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(data, null, 2) + '\n');
