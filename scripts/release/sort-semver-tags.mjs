#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const SEMVER_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const NUMERIC_IDENTIFIER = /^[0-9]+$/u;

function fail(message) {
  process.stderr.write(`sort-semver-tags: error: ${message}\n`);
  process.exit(1);
}

function parseTag(tag) {
  const match = SEMVER_TAG.exec(tag);
  if (!match) {
    fail(`invalid SemVer release tag '${tag}'`);
  }

  const prerelease = match[4]?.split('.') ?? [];
  for (const identifier of prerelease) {
    if (
      NUMERIC_IDENTIFIER.test(identifier)
      && identifier.length > 1
      && identifier.startsWith('0')
    ) {
      fail(`invalid SemVer release tag '${tag}': numeric prerelease identifiers cannot have a leading zero`);
    }
  }

  return {
    tag,
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

function compareNumeric(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareIdentifiers(left, right) {
  const leftNumeric = NUMERIC_IDENTIFIER.test(left);
  const rightNumeric = NUMERIC_IDENTIFIER.test(right);
  if (leftNumeric && rightNumeric) {
    return compareNumeric(BigInt(left), BigInt(right));
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareSemver(left, right) {
  for (let index = 0; index < left.core.length; index += 1) {
    const coreOrder = compareNumeric(left.core[index], right.core[index]);
    if (coreOrder !== 0) return coreOrder;
  }

  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }

  const commonLength = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < commonLength; index += 1) {
    const identifierOrder = compareIdentifiers(
      left.prerelease[index],
      right.prerelease[index],
    );
    if (identifierOrder !== 0) return identifierOrder;
  }
  return compareNumeric(
    BigInt(left.prerelease.length),
    BigInt(right.prerelease.length),
  );
}

const [mode, tag] = process.argv.slice(2);
if (mode === '--validate' && tag && process.argv.length === 4) {
  parseTag(tag);
  process.exit(0);
}

if (mode === '--sort-desc' && !tag && process.argv.length === 3) {
  const tags = readFileSync(0, 'utf8')
    .split(/\r?\n/u)
    .filter((entry) => entry.length > 0)
    .map(parseTag);
  tags.sort((left, right) => compareSemver(right, left));
  if (tags.length > 0) {
    process.stdout.write(`${tags.map((entry) => entry.tag).join('\n')}\n`);
  }
  process.exit(0);
}

fail('usage: sort-semver-tags.mjs --validate TAG | --sort-desc');
