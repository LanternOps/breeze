#!/usr/bin/env node
// Gitignore-style path policy used by the server-only release guard.
//
// Dependency-free on purpose: the guard runs this file from the BASE release's
// tree, so it must work with nothing but Node.
//
// Syntax (one pattern per line):
//   - `#` starts a comment (at line start, or after whitespace);
//   - a leading `!` negates (re-includes) the pattern;
//   - the LAST matching rule decides;
//   - patterns are anchored at the repository root;
//   - `**` matches any number of path segments, `*` any run of characters
//     within one segment, `?` one character within a segment; every other
//     character is literal.

import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  throw new Error(message);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      const atSegmentStart = index === 0 || pattern[index - 1] === '/';
      const followedBySlash = pattern[index + 2] === '/';
      index += 1;
      if (atSegmentStart && followedBySlash) {
        // `**/` — zero or more whole directories.
        source += '(?:[^/]+/)*';
        index += 1;
      } else {
        // trailing `/**` or an embedded `**` — anything, across segments.
        source += '.*';
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(character);
    }
  }
  return new RegExp(`^${source}$`, 'u');
}

function stripComment(line) {
  if (line.trimStart().startsWith('#')) return '';
  const inline = line.search(/\s#/u);
  return (inline === -1 ? line : line.slice(0, inline)).trim();
}

export function loadPolicy(text) {
  const rules = [];
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = stripComment(rawLine);
    if (!line) continue;
    const negate = line.startsWith('!');
    const pattern = negate ? line.slice(1).trim() : line;
    if (!pattern) fail(`policy line ${index + 1}: empty pattern`);
    if (
      pattern.startsWith('/')
      || pattern.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')
    ) {
      fail(`policy line ${index + 1}: '${pattern}' must be a normalized repository-relative path`);
    }
    rules.push({ pattern, negate, regex: globToRegExp(pattern) });
  }
  return rules;
}

export function isMatched(rules, path) {
  let matched = false;
  for (const rule of rules) {
    if (rule.regex.test(path)) matched = !rule.negate;
  }
  return matched;
}

export function matchPaths(rules, paths) {
  return paths.filter((path) => isMatched(rules, path));
}

function readPaths(text) {
  const separator = text.includes('\0') ? '\0' : '\n';
  return text.split(separator).map((path) => (separator === '\n' ? path.replace(/\r$/u, '') : path)).filter(Boolean);
}

function runCli(argv) {
  const [command, ...args] = argv;
  if (command !== 'match' || args.length !== 2 || args[0] !== '--policy') {
    fail('usage: release-path-policy.mjs match --policy FILE < paths');
  }
  const rules = loadPolicy(readFileSync(args[1], 'utf8'));
  const paths = readPaths(readFileSync(0, 'utf8'));
  const matches = matchPaths(rules, paths);
  if (matches.length > 0) process.stdout.write(`${matches.join('\n')}\n`);
  // Completion trailer: the guard refuses unless this is the last stderr line
  // and its counts agree with what it fed in and got back, so "no output"
  // can never be read as "nothing matched".
  process.stderr.write(`# matched=${matches.length} of ${paths.length}\n`);
}

// Compare real paths: the guard runs these helpers from a temporary directory
// that may sit behind a symlink (/var -> /private/var on macOS). A plain URL
// comparison would then silently skip the CLI and exit 0 with no output —
// which the guard catches by requiring the completion trailer from runCli.
function invokedAsCli() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${basename(process.argv[1])}: ${error.message}\n`);
    process.exitCode = 2;
  }
}
