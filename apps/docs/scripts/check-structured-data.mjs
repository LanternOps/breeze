// Asserts the JSON-LD in a built docs site (run after `astro build`).
// Usage: node scripts/check-structured-data.mjs [distDir]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'dist';
const SITE = 'https://docs.breezermm.com';
const ORG_ID = 'https://breezermm.com/#organization';
const failures = [];
const fail = (m) => failures.push(m);

function blocks(file) {
  const html = readFileSync(join(dist, file), 'utf8');
  const out = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(re)) {
    try {
      out.push(JSON.parse(m[1]));
    } catch (e) {
      fail(`${file}: JSON-LD block does not parse (${e.message})`);
    }
  }
  return out;
}
const ofType = (list, t) => list.filter((b) => b['@type'] === t);

function frontmatterTitle(path) {
  const src = readFileSync(path, 'utf8');
  return src.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1];
}

// Homepage: exactly one Organization, no Article.
const home = blocks('index.html');
if (ofType(home, 'Organization').length !== 1) fail('index.html: expected exactly one Organization');
if (ofType(home, 'Article').length !== 0) fail('index.html: must not carry Article');
const org = ofType(home, 'Organization')[0];
if (org && org['@id'] !== ORG_ID) fail(`index.html: Organization @id is ${org['@id']}`);

// Normal doc page: exactly one Article with expected headline and canonical URL.
const docFile = 'getting-started/quickstart/index.html';
const doc = blocks(docFile);
const articles = ofType(doc, 'Article');
if (articles.length !== 1) fail(`${docFile}: expected exactly one Article, found ${articles.length}`);
else {
  const a = articles[0];
  const title = frontmatterTitle('src/content/docs/getting-started/quickstart.mdx')
    ?? frontmatterTitle('src/content/docs/getting-started/quickstart.md');
  if (!title || a.headline !== title) fail(`${docFile}: headline ${JSON.stringify(a.headline)} !== ${JSON.stringify(title)}`);
  const url = `${SITE}/getting-started/quickstart/`;
  if (a.url !== url) fail(`${docFile}: url ${a.url} !== ${url}`);
  if (a.mainEntityOfPage?.['@id'] !== url) fail(`${docFile}: mainEntityOfPage mismatch`);
  if (a.author?.['@id'] !== ORG_ID || a.publisher?.['@id'] !== ORG_ID) fail(`${docFile}: author/publisher must reference ${ORG_ID}`);
  if ('datePublished' in a) fail(`${docFile}: datePublished must be omitted`);
  if (a.dateModified && Number.isNaN(Date.parse(a.dateModified))) fail(`${docFile}: bad dateModified`);
}

// 404: no Article.
if (ofType(blocks('404.html'), 'Article').length !== 0) fail('404.html: must not carry Article');

if (failures.length) {
  console.error('FAIL\n' + failures.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}
console.log('OK: structured data checks passed');
