import { readFileSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function parseMap(text) {
  return text.split('\n').map((line) => line.split('#')[0].trim()).filter(Boolean).map((line) => {
    const parts = line.split(/\s+/u);
    if (parts.length !== 2) throw new Error(`Invalid reader map row: ${line}`);
    return { test: parts[0], pattern: parts[1] };
  });
}

export function plan(readerTests, mapEntries) {
  const files = [...new Set(readerTests.length ? readerTests : mapEntries.map((entry) => entry.test))];
  if (!files.length) throw new Error('Reader plan is empty: nothing to run');
  const groups = new Map();
  for (const file of files) {
    if (!/^(apps|packages|ee|scripts)\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_./-]+)?\.test\.(ts|tsx|mjs)$/u.test(file) || file.includes('..')) {
      throw new Error(`Invalid reader test path: ${file}`);
    }
    let exists = false;
    try { exists = statSync(join(REPO_ROOT, file)).isFile(); } catch { /* Report the offending path below. */ }
    if (!exists) throw new Error(`Reader test does not exist: ${file}`);
    const isNode = file.endsWith('.mjs');
    const [root, name, ...relative] = file.split('/');
    if (!isNode && (root === 'scripts' || !relative.length)) throw new Error(`No runner owns reader test: ${file}`);
    const key = isNode ? 'node' : `${root}/${name}`;
    if (!groups.has(key)) groups.set(key, isNode
      ? { cmd: 'node', args: ['--test'], cwd: REPO_ROOT }
      : { cmd: 'pnpm', args: ['--filter', `./${key}`, 'exec', 'vitest', 'run'], cwd: REPO_ROOT });
    groups.get(key).args.push(isNode ? file : relative.join('/'));
  }
  return [...groups.values()];
}

function main() {
  let commands;
  try {
    const selection = (process.env.READER_TESTS ?? '').trim().split(/\s+/u).filter(Boolean);
    const map = parseMap(readFileSync(join(REPO_ROOT, '.github/scripts/path-reader-map.txt'), 'utf8'));
    if (!selection.length) console.log('run-reader-tests: READER_TESTS empty, running every mapped reader test (fail-closed)');
    commands = plan(selection, map);
  } catch (error) {
    console.error(`run-reader-tests: ${error.message}`);
    return 2;
  }
  console.log(JSON.stringify(commands, null, 2));
  for (const { cmd, args, cwd } of commands) {
    console.log(`::group::${cmd} ${args.join(' ')}`);
    const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
    console.log('::endgroup::');
    if (result.status !== 0) {
      if (result.error) console.error(result.error.message);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
