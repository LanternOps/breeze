#!/usr/bin/env node
// Fails when a Tauri app's npm packages and Rust crates disagree on major.minor.
//
// The Tauri CLI refuses to build when `tauri` (crate) and `@tauri-apps/api`
// (npm) — or `tauri-plugin-<x>` and `@tauri-apps/plugin-<x>` — differ in
// major.minor. Dependabot bumps the cargo and npm ecosystems in separate PRs,
// so a crate-only bump merges green and only breaks the release build
// (v0.121.0: tauri 2.12.0 vs @tauri-apps/api 2.11.0). This compares the two
// lockfiles directly so the mismatch reds CI instead.
//
// Usage: node scripts/check-tauri-versions.mjs [repo-root]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');

function cargoCrates(lockPath) {
  const crates = new Map();
  const re = /^\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/gm;
  for (const [, name, version] of readFileSync(lockPath, 'utf8').matchAll(re)) {
    if (name === 'tauri' || name.startsWith('tauri-plugin-')) crates.set(name, version);
  }
  return crates;
}

// Resolved versions of @tauri-apps/* for one importer in pnpm-lock.yaml.
function npmPackages(lockText, importerPath) {
  const lines = lockText.split('\n');
  const start = lines.indexOf(`  ${importerPath}:`);
  const pkgs = new Map();
  if (start === -1) return pkgs;
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^ {0,2}\S/.test(line)) break; // next importer or top-level key
    const name = line.match(/^ {6}'?(@tauri-apps\/[^':]+)'?:\s*$/);
    if (name) { current = name[1]; continue; }
    if (/^ {6}\S/.test(line)) { current = null; continue; }
    const version = line.match(/^ {8}version: (\S+)/);
    if (current && version) pkgs.set(current, version[1].replace(/\(.*$/, ''));
  }
  return pkgs;
}

const minor = (v) => v.split('.').slice(0, 2).join('.');

const lockText = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
const appsDir = join(root, 'apps');
const errors = [];
for (const app of readdirSync(appsDir).sort()) {
  const cargoLock = join(appsDir, app, 'src-tauri', 'Cargo.lock');
  if (!existsSync(cargoLock)) continue;
  const label = `apps/${app}`;
  const crates = cargoCrates(cargoLock);
  const npm = npmPackages(lockText, label);
  const pairs = [];
  for (const [crate, crateVersion] of crates) {
    const npmName = crate === 'tauri' ? '@tauri-apps/api' : `@tauri-apps/${crate.slice('tauri-'.length)}`;
    const npmVersion = npm.get(npmName);
    if (!npmVersion) {
      if (crate === 'tauri') errors.push(`${label}: tauri ${crateVersion} in Cargo.lock but @tauri-apps/api is not resolved in pnpm-lock.yaml`);
      continue; // Rust-only plugin
    }
    if (minor(crateVersion) !== minor(npmVersion)) {
      errors.push(`${label}: ${crate} ${crateVersion} (Cargo.lock) vs ${npmName} ${npmVersion} (pnpm-lock.yaml) — major.minor must match`);
    } else {
      pairs.push(`${crate} ${crateVersion} = ${npmName} ${npmVersion}`);
    }
  }
  if (pairs.length) console.log(`${label}: ${pairs.join(', ')}`);
}

if (errors.length) {
  for (const e of errors) console.error(`ERROR ${e}`);
  console.error('\nBump the npm package (apps/<app>/package.json + pnpm install) to the crate\'s minor, or pin the crate in Cargo.toml.');
  process.exit(1);
}
