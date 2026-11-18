// node --test scripts/prod/caddy-route-parity.test.mjs
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkDrift,
  classifyBillingResponses,
  matcherNames,
  webBillingCarveouts,
} from './caddy-route-parity.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_CADDYFILE = readFileSync(path.join(REPO_ROOT, 'docker/Caddyfile.prod'), 'utf8');

// The hosted copy as it stood before the #11647 hotfix: identical to the repo
// file except that the @webBillingAutopay block is gone.
const AUTOPAY_BLOCK = /\n[ \t]*@webBillingAutopay path[^\n]*\n[ \t]*handle @webBillingAutopay \{[^}]*\}\n/;
assert.match(REPO_CADDYFILE, AUTOPAY_BLOCK, 'fixture precondition: repo file carries @webBillingAutopay');
const PRE_HOTFIX_COPY = REPO_CADDYFILE.replace(AUTOPAY_BLOCK, '\n');

test('repo Caddyfile carve-outs include every /billing web page', () => {
  const pages = [...new Set(
    readdirSync(path.join(REPO_ROOT, 'apps/web/src/pages/billing'), { withFileTypes: true })
      .map(e => (e.isDirectory() ? e.name : e.name.replace(/\.astro$/, ''))),
  )].map(s => `/billing/${s}`).sort();
  assert.ok(pages.includes('/billing/autopay'), 'fixture precondition: autopay page exists');
  assert.deepEqual(webBillingCarveouts(REPO_CADDYFILE).map(c => c.path), pages);
});

test('matcher names ignore comments and include block-form matchers', () => {
  const names = matcherNames('# @commented path /x\n@a path /a\n@b {\n  path /b\n}\n  # @c path /c\n');
  assert.deepEqual([...names].sort(), ['@a', '@b']);
});

test('the repo file is in parity with itself', () => {
  assert.deepEqual(checkDrift(REPO_CADDYFILE, REPO_CADDYFILE), []);
});

test('a running copy missing @webBillingAutopay fails drift (the #11647 incident)', () => {
  const problems = checkDrift(REPO_CADDYFILE, PRE_HOTFIX_COPY);
  assert.ok(problems.some(p => p.includes('@webBillingAutopay')), problems.join('\n'));
  assert.ok(problems.some(p => p.includes('/billing/autopay')), problems.join('\n'));
});

test('extra hosted-only matchers in the running copy are allowed', () => {
  const extended = REPO_CADDYFILE.replace(
    /\n([ \t]*)@billing path /,
    '\n$1@hostedOnly path /hosted-only\n$1handle @hostedOnly {\n$1  respond 204\n$1}\n\n$1@billing path ',
  );
  assert.deepEqual(checkDrift(REPO_CADDYFILE, extended), []);
});

test('--allow suppresses a deliberately absent matcher but not the billing route check', () => {
  const problems = checkDrift(REPO_CADDYFILE, PRE_HOTFIX_COPY, { allow: ['@webBillingAutopay'] });
  assert.ok(!problems.some(p => p.startsWith('missing matcher')), problems.join('\n'));
  assert.ok(problems.some(p => p.includes('/billing/autopay')), problems.join('\n'));
});

test('a carve-out placed after the sidecar route fails drift', () => {
  const block = REPO_CADDYFILE.match(AUTOPAY_BLOCK)[0];
  const reordered = PRE_HOTFIX_COPY.replace(
    /(\n[ \t]*handle @billing \{[^}]*\}\n)/,
    `$1${block}`,
  );
  assert.notEqual(reordered, PRE_HOTFIX_COPY, 'fixture precondition: block re-inserted');
  const problems = checkDrift(REPO_CADDYFILE, reordered);
  assert.ok(!problems.some(p => p.startsWith('missing matcher')), problems.join('\n'));
  assert.ok(problems.some(p => p.includes('/billing/autopay')), problems.join('\n'));
});

const sidecar = { status: 200, location: null, body: '<title>Breeze Billing</title>' };

test('smoke: a web page response differing from /billing passes', () => {
  const results = classifyBillingResponses(sidecar, [
    { path: '/billing/invoices', status: 200, location: null, body: '<title>Invoices | Breeze RMM</title>' },
    { path: '/billing/quotes', status: 302, location: '/login?next=/billing/quotes', body: '' },
  ]);
  assert.deepEqual(results.map(r => r.ok), [true, true]);
});

test('smoke: a page byte-identical to /billing is reported as served by the sidecar', () => {
  const [result] = classifyBillingResponses(sidecar, [{ path: '/billing/autopay', ...sidecar }]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /sidecar/);
});

test('smoke: a failed request is a failure, not a pass', () => {
  const [result] = classifyBillingResponses(sidecar, [{ path: '/billing/autopay', error: 'ECONNREFUSED' }]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /ECONNREFUSED/);
});

test('smoke: an unreachable /billing baseline fails every page', () => {
  const results = classifyBillingResponses({ error: 'timeout' }, [
    { path: '/billing/invoices', status: 200, location: null, body: 'x' },
  ]);
  assert.equal(results[0].ok, false);
});
