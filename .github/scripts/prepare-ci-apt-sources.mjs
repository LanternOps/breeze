import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// These dependency phases install distro packages, not Chrome. Exclude only
// this source; every retained entry and its trust configuration stays intact.
const chromeUris = new Set([
  'https://dl.google.com/linux/chrome-stable/deb',
  'http://dl.google.com/linux/chrome-stable/deb',
  'https://dl.google.com/linux/chrome/deb',
  'http://dl.google.com/linux/chrome/deb',
]);
const isChrome = (uri) => chromeUris.has(uri.replace(/\/$/u, ''));

export function filterSource(name, text) {
  let retained = 0;
  let excluded = 0;
  if (name.endsWith('.list')) {
    const filtered = text.split(/(?<=\n)/u).filter((line) => {
      if (/^\s*(?:#|$)/u.test(line)) return true;
      const entry = line.match(/^\s*deb(?:-src)?\s+(?:\[[^\]\n]*\]\s+)?(?!\[)(\S+)\s+\S+/u);
      if (!entry) throw new Error(`Unrecognized apt list entry in ${name}`);
      if (isChrome(entry[1])) { excluded++; return false; }
      retained++;
      return true;
    }).join('');
    return { text: filtered, retained, excluded };
  }
  if (!name.endsWith('.sources')) throw new Error(`Unsupported source file: ${name}`);
  // Keep separators and every retained stanza byte-for-byte, including inline
  // Signed-By keys. A stanza mixing Chrome and another URI is ambiguous: stop.
  const parts = text.split(/(\r?\n[\t ]*\r?\n)/u);
  for (let i = 0; i < parts.length; i += 2) {
    const fields = new Map();
    let field;
    for (const line of parts[i].split(/\r?\n/u)) {
      if (/^\s*(?:#|$)/u.test(line)) continue;
      if (/^[\t ]/u.test(line)) {
        if (!field) throw new Error(`Orphan continuation in ${name}`);
        fields.set(field, `${fields.get(field)} ${line.trim()}`);
        continue;
      }
      const match = line.match(/^([\w-]+):\s*(.*)$/u);
      if (!match) throw new Error(`Unrecognized apt stanza in ${name}`);
      field = match[1].toLowerCase();
      if (fields.has(field)) throw new Error(`Duplicate apt field in ${name}: ${field}`);
      fields.set(field, match[2]);
    }
    if (!fields.size || fields.get('enabled')?.toLowerCase() === 'no') continue;
    const uris = fields.get('uris')?.trim().split(/\s+/u);
    if (!uris?.length || !uris[0]) throw new Error(`Missing apt URIs in ${name}`);
    const chrome = uris.filter(isChrome);
    if (chrome.length && chrome.length !== uris.length) {
      throw new Error(`Mixed Chrome and unrelated apt URIs in ${name}`);
    }
    if (chrome.length) { parts[i] = ''; excluded++; } else { retained++; }
  }
  return { text: parts.join(''), retained, excluded };
}

export function prepareSources(sourceRoot, output) {
  if (path.resolve(sourceRoot) === path.resolve(output)) throw new Error('Output must be separate from source');
  if (readdirSync(output).length) throw new Error('Output must be an empty temporary directory');
  const files = [];
  const main = path.join(sourceRoot, 'sources.list');
  if (existsSync(main)) files.push(['sources.list', main]);
  const parts = path.join(sourceRoot, 'sources.list.d');
  if (existsSync(parts)) {
    for (const name of readdirSync(parts).sort()) {
      if (/^[\w.-]+\.(?:list|sources)$/u.test(name)) files.push([`sources.list.d/${name}`, path.join(parts, name)]);
    }
  }
  // Parse all files before publishing any configuration. Errors fail closed.
  const results = files.map(([name, file]) => ({ name, ...filterSource(name, readFileSync(file, 'utf8')) }));
  if (!results.some((r) => r.retained)) throw new Error('No active non-Chrome apt source remains');
  mkdirSync(path.join(output, 'sources.list.d'));
  writeFileSync(path.join(output, 'sources.list'), '');
  for (const result of results) writeFileSync(path.join(output, result.name), result.text);
  return { files: results.length, excluded: results.reduce((n, r) => n + r.excluded, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: prepare-ci-apt-sources.mjs SOURCE_ROOT EMPTY_OUTPUT_DIRECTORY');
    const result = prepareSources(process.argv[2], process.argv[3]);
    console.log(`Prepared temporary apt sources; excluded ${result.excluded} Chrome entries from ${result.files} files. Verification remains enabled.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
