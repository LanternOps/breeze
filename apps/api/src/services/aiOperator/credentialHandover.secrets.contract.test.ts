/**
 * THE SECRET-ABSENCE CONTRACT (spec §6.4, this wave's D-R2-6).
 *
 * The temporary credential for a created account exists in exactly one place:
 * `action_intents.result`, sealed, revealed once through the shipped
 * `POST /action-intents/:id/reveal-secret`. This file asserts, mechanically,
 * that R2 put it nowhere else — because every one of the places below is a
 * place a well-meaning change could put it, and most of them are permanent
 * records a tenant can export.
 *
 * It is written as a SOURCE scan plus a BEHAVIOURAL scan, because each catches
 * what the other cannot: the source scan catches a field nobody exercises yet,
 * and the behavioural scan catches a value that arrives at runtime through a
 * path no identifier names.
 *
 * GROWS WITH THE WAVE. The file lists below are EXPLICIT (a glob would
 * silently stop covering a renamed file) and a listed file that is missing
 * FAILS. Task 11 lands first, so only files that exist at Task 11 are listed;
 * Tasks 7, 8, 9 and 12 append theirs to `R2A_CREATED_FILES`
 * (`identityProvisioning.ts`, `taskContextOnboarding.ts`, `onboardingAccounts.ts`,
 * `onboardingAdvancers.ts`; Task 3 adds `recipes/identityOnboarding.ts`), and
 * Tasks 3, 12 and 13 append the plan's behavioural cases for the create
 * effect's arguments, the advancer's event detail and the completion record /
 * ticket comment.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { taskCheckpointSchema } from '@breeze/shared';

const h = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

/**
 * A raw stub, NOT the table-keyed one: it returns whatever the rows carry,
 * selected or not, so a mapper that spread a row (instead of naming fields)
 * would leak the injected ciphertext/plaintext into the view.
 */
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(h.rows.map((r) => ({ ...r }))).then(resolve, reject);
  return {
    db: { select: () => chain },
    hasDbAccessContext: () => true,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { listCreatedAccountsForTask } from './credentialHandover';

const OPERATOR_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * Non-test source files R2a CREATES under `services/aiOperator/`. Appended by
 * each later task (see the header). These must not name the plaintext carrier
 * and must not name the checklist tick column at all (G8).
 */
const R2A_CREATED_FILES: readonly string[] = [
  'credentialHandover.ts',
  'recipes/capabilityMap.ts',
  'recipes/identityOnboarding.ts',
  'identityProvisioning.ts',
  'taskContextOnboarding.ts',
  'onboardingAccounts.ts',
];

/**
 * Non-test source files R2a MODIFIES under `services/aiOperator/`. Shipped
 * files may legitimately read the tick column (completionRecord.ts reads the tick
 * evidence), so only the plaintext-carrier check applies to them.
 */
const R2A_MODIFIED_FILES: readonly string[] = [
  'completionRecord.ts',
  'contactResolution.ts',
  'effectDispatch.ts',
  'effectProbes/google.ts',
  'identityDiscovery.ts',
  'manualWork.ts',
  'planApproval.ts',
  'planningSnapshot.ts',
  'recipes/identityOffboarding.ts',
  'recipes/index.ts',
  'recipes/types.ts',
  'taskCoordinator.ts',
  'taskService.ts',
];

/**
 * The plaintext carrier name, permitting only the marker/ciphertext keys.
 * `credentialHandover.ts` legitimately works with the MARKER keys — that is the
 * whole point of the negative lookahead (and it imports them as constants from
 * `resultSecrets.ts`, so it never spells even those).
 */
const PLAINTEXT_CARRIER = /temporaryPassword(?!Enc|Revealed|Expired|SealFailed)/;

function read(rel: string): string {
  return readFileSync(join(OPERATOR_DIR, rel), 'utf8');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...walk(full)); continue; }
    if (name.endsWith('.ts') && !name.includes('.test.') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('secret-absence contract — source', () => {
  it('1. every listed onboarding file exists (a missing one is a failure, not a silent gap)', () => {
    for (const rel of [...R2A_CREATED_FILES, ...R2A_MODIFIED_FILES]) {
      expect(() => read(rel), `listed file is missing: ${rel}`).not.toThrow();
    }
  });

  it('1b. no file R2a created or modified names the plaintext carrier', () => {
    // Controls: the pattern catches the carrier and lets the marker keys through.
    expect(PLAINTEXT_CARRIER.test('result.temporaryPassword')).toBe(true);
    for (const marker of ['temporaryPasswordEnc', 'temporaryPasswordRevealed', 'temporaryPasswordExpired', 'temporaryPasswordSealFailed']) {
      expect(PLAINTEXT_CARRIER.test(marker), marker).toBe(false);
    }
    const offenders = [...R2A_CREATED_FILES, ...R2A_MODIFIED_FILES].filter((rel) => PLAINTEXT_CARRIER.test(read(rel)));
    expect(offenders).toEqual([]);
  });

  it('1c. no file R2a created names the checklist tick column (the tick is human-only; G8)', () => {
    // Assembled from parts so this file does not itself name the column (G8:
    // no onboarding file contains it, this one included).
    const tickColumn = new RegExp(`\\b(${['done', 'At'].join('')}|${['done', 'at'].join('_')})\\b`);
    expect(tickColumn.test(['row.', 'done', 'At'].join(''))).toBe(true);
    const offenders = R2A_CREATED_FILES.filter((rel) => tickColumn.test(read(rel)));
    expect(offenders).toEqual([]);
  });

  it('1d. credentialHandover.ts names the keys only through resultSecrets constants and never imports a value-touching helper', () => {
    const src = read('credentialHandover.ts');
    expect(src).not.toMatch(/\btemporaryPassword[A-Za-z]*\b/);
    for (const name of ['TEMP_PASSWORD_ENC_KEY', 'TEMP_PASSWORD_LEGACY_KEY', 'TEMP_PASSWORD_REVEALED_KEY',
      'TEMP_PASSWORD_EXPIRED_KEY', 'TEMP_PASSWORD_SEAL_FAILED_KEY', 'REVEAL_WINDOW_DAYS']) {
      expect(src, name).toContain(name);
    }
    expect(src).toMatch(/from '\.\.\/actionIntents\/resultSecrets'/);
    // `hasSealedTemporaryPassword` takes the parsed `result`, which would mean
    // selecting the column into application memory; the SQL form never does.
    for (const fn of ['hasSealedTemporaryPassword', 'unsealTemporaryPassword', 'burnTemporaryPassword', 'decryptSecret']) {
      expect(src, fn).not.toContain(fn);
    }
  });

  it('2. nothing under services/aiOperator/ unseals or burns a credential (the reveal route is the only caller)', () => {
    const files = walk(OPERATOR_DIR);
    expect(files.length).toBeGreaterThan(40);
    const offenders = files
      .filter((f) => /\b(unsealTemporaryPassword|burnTemporaryPassword|decryptSecret)\b/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(OPERATOR_DIR.length));
    expect(offenders).toEqual([]);
  });
});

describe('secret-absence contract — behaviour', () => {
  const SEALED = 'enc:v3:SEALED-CIPHERTEXT-SENTINEL';
  const PLAIN = 'Plain-Sentinel#4821';

  it('3. the task checkpoint cannot hold it: every arm is strict, so an extra credential key is refused', () => {
    const onboarding = {
      version: 1,
      checkpointKind: 'identity_onboarding',
      recipeInput: {
        displayName: 'Priya Raman',
        m365: { userPrincipalName: 'priya@customer.example', mailNickname: 'priya', usageLocation: 'CA' },
      },
    };
    // Control: the clean checkpoint parses, so the refusal below is the extra key's.
    expect(taskCheckpointSchema.safeParse(onboarding).success).toBe(true);
    expect(() => taskCheckpointSchema.parse({ ...onboarding, temporaryPassword: PLAIN })).toThrow();
    expect(() => taskCheckpointSchema.parse({ ...onboarding, temporaryPasswordEnc: SEALED })).toThrow();
  });

  describe('4. the projection cannot carry it, even when a row does', () => {
    beforeEach(() => {
      h.rows = [{
        provider: 'm365',
        principalLabel: 'priya@customer.example',
        externalId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        intentId: '00000000-0000-4000-8000-0000000000d1',
        intentStatus: 'completed',
        executedAt: new Date(Date.now() - 60 * 60 * 1000),
        requestedByUserId: '00000000-0000-4000-8000-0000000000c1',
        approverUserId: '00000000-0000-4000-8000-0000000000c1',
        approverName: 'Sam Approver',
        hasSealedCredential: true,
        hasRevealedMarker: false,
        hasExpiredMarker: false,
        hasSealFailedMarker: false,
        // Injected: a future query that selected the column would hand these over.
        result: { action: 'm365.user.create', temporaryPasswordEnc: SEALED, temporaryPassword: PLAIN },
        temporaryPassword: PLAIN,
        temporaryPasswordEnc: SEALED,
      }];
    });

    it('names fields, never spreads: the view has exactly the documented keys and neither value', async () => {
      const views = await listCreatedAccountsForTask('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1');
      expect(views).toHaveLength(1);
      expect(Object.keys(views[0]!).sort()).toEqual([
        'credentialState', 'externalId', 'intentId', 'principalLabel', 'provider',
        'revealExpiresAt', 'revealableByName', 'revealableByUserId',
      ]);
      const json = JSON.stringify(views);
      expect(json).not.toContain(SEALED);
      expect(json).not.toContain(PLAIN);
      expect(json).not.toContain('enc:v3:');
      expect(json).not.toMatch(/temporaryPassword/);
      // Absence is not achieved by omitting the subject: the STATE is said.
      expect(views[0]!.credentialState).toBe('available');
    });
  });
});
