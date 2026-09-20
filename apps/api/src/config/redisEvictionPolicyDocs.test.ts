import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up (same as composeBindMounts.test.ts).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Why this test exists
 * --------------------
 * Breeze runs Redis with `maxmemory-policy noeviction` on purpose: BullMQ job
 * hashes and the remote-WS lease records must never be evicted out from under a
 * running job. `services/remoteWsRedisTopology.ts` refuses remote admission
 * unless the live policy reads `noeviction`, and `scripts/prod/deploy.sh`
 * aborts a deploy that finds anything else — so the policy is a contract, not a
 * tuning knob.
 *
 * The docs drifted away from it anyway: `reference/troubleshooting.mdx` told
 * operators Redis "uses allkeys-lru eviction by default" (#6249, split out of
 * #6177), which is the opposite of what ships. An operator diagnosing a full
 * Redis would have concluded old keys were being reclaimed automatically, when
 * in reality writes were failing with OOM and the AOF replayed the same
 * over-cap dataset on every restart.
 *
 * This guard pins both halves: the compose files keep `noeviction`, and no
 * published doc claims Breeze's Redis evicts anything.
 */

const COMPOSE_FILES = ['docker-compose.yml', 'deploy/docker-compose.prod.yml'];

const DOCS_ROOT = path.join(REPO_ROOT, 'apps/docs/src/content/docs');

/** Eviction policies that would contradict the shipped `noeviction` config. */
const EVICTING_POLICIES = [
  'allkeys-lru',
  'allkeys-lfu',
  'allkeys-random',
  'volatile-lru',
  'volatile-lfu',
  'volatile-random',
  'volatile-ttl',
];

const listTrackedDocs = (): string[] =>
  execFileSync('git', ['ls-files', '-z', 'apps/docs/src/content/docs'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => file.endsWith('.mdx') || file.endsWith('.md'));

describe('Redis eviction policy contract', () => {
  it.each(COMPOSE_FILES)('%s configures maxmemory-policy noeviction', (file) => {
    const contents = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    expect(contents).toContain('maxmemory-policy noeviction');
    for (const policy of EVICTING_POLICIES) {
      expect(contents).not.toContain(`maxmemory-policy ${policy}`);
    }
  });

  it('no published doc claims Breeze Redis uses an evicting policy', () => {
    const offenders: string[] = [];

    for (const file of listTrackedDocs()) {
      const lines = readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        const matched = EVICTING_POLICIES.find((policy) => line.includes(policy));
        if (matched) offenders.push(`${file}:${index + 1} mentions ${matched}`);
      });
    }

    expect(offenders, [
      'Breeze ships Redis with maxmemory-policy noeviction and both the remote-WS',
      'topology monitor and scripts/prod/deploy.sh enforce it. A doc naming an',
      'evicting policy tells operators old keys are reclaimed automatically; they',
      'are not — writes fail with OOM and the AOF replays the full dataset on',
      'restart. Fix the doc, or change the compose default first and update this',
      'contract deliberately.',
    ].join(' ')).toEqual([]);
  });
});
