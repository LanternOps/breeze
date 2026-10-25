import { test, expect } from '../fixtures';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperatorLibraryPage, OperatorTaskPanelsPage, StartRecipeFormPage } from '../pages/OperatorLibraryPage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Operator Recipe Library web surface (W06 R1b, #6171). `data-testid` only.
 *
 * NEEDS the stack's untracked env to set AI_OPERATOR_TASKS_ENABLED,
 * AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED and
 * AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED to true (the /operator nav
 * and launchers ride `features.aiOperatorTasks`, which is the first two; the
 * offboarding card is `unavailable` unless the third is on), plus
 * BREEZE_AI_AGENTS_ENABLED=true — with the AI-agents kill switch off the
 * helpdesk agent resolves disabled and every effect previews as hand work.
 * No tracked file enables any of them.
 *
 * WHAT IS REAL: the Library read and its readiness (computed by the server
 * from rows), the contact launcher on the org record page, the start form,
 * and the draft preview (POST /task-drafts, which writes nothing); the task
 * page's steps and plan panels read back through the real GET /tasks/:id.
 *
 * WHAT IS SEEDED (seed-operator-recipe-library.sql), WITH GENERIC PLACEHOLDERS:
 * the helpdesk agent, one Google Workspace connection row with status
 * 'active' (readiness reads only the status), one contact, and one waiting
 * identity task with its step rows and a pending plan approval. Readiness is
 * never faked in the UI.
 *
 * WHAT IS SKIPPED, AND WHY: submitting the form. Admission resolves the
 * person's Google account through the connection's service-account key, and
 * a placeholder key cannot reach a provider, so admission answers
 * `no_provider_account`. Making it pass would need real provider
 * credentials; the admission path itself is proven against real Postgres by
 * aiOperatorIdentityAdmission.integration.test.ts.
 */

function stackDescriptor(): { pgContainer?: string } | null {
  const p = process.env.E2E_STACK_FILE ?? path.resolve(__dirname, '../..', '.breeze-stack.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { pgContainer?: string }) : null;
}

function pgContainer(): string {
  return process.env.E2E_PG_CONTAINER ?? stackDescriptor()?.pgContainer ?? 'breeze-postgres';
}

function psqlFile(file: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: readFileSync(path.resolve(__dirname, '..', file), 'utf8') },
  );
}

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

let ids: { orgId: string; contactId: string; taskId: string };

test.describe.configure({ mode: 'serial' });

test.describe('Operator Recipe Library', () => {
  test.beforeAll(() => {
    const out = psqlFile('seed-operator-recipe-library.sql');
    const pick = (k: string) => {
      const v = new RegExp(`${k}=([0-9a-f-]{36})`).exec(out)?.[1];
      if (!v) throw new Error(`seed did not report ${k}:\n${out}`);
      return v;
    };
    ids = { orgId: pick('ORG_ID'), contactId: pick('CONTACT_ID'), taskId: pick('TASK_ID') };
  });

  test.afterAll(() => {
    // The placeholder connection would make every later spec see a "connected"
    // Google Workspace; remove it. The task and contact are inert and stay.
    psql(`SELECT set_config('breeze.scope','system',false); DELETE FROM google_workspace_connections WHERE service_account_key = 'e2e-placeholder-not-a-key';`);
  });

  test('the Library shows the offboarding card with its readiness', async ({ authedPage: page }) => {
    const library = new OperatorLibraryPage(page);
    await library.pinOrg(ids.orgId);
    await library.gotoLibrary();
    await expect(library.card('identity_offboarding')).toBeVisible({ timeout: 30_000 });
    // Not `unavailable`: one provider connection is active. Which of the other
    // two it reads is the server's call (it depends on the seeded agent's tools).
    await expect(library.readiness('identity_offboarding')).not.toHaveAttribute('data-readiness', 'unavailable');
    await expect(library.start('identity_offboarding')).toBeEnabled();
  });

  test('from a contact: the start form opens with that person and previews the steps grouped by provider', async ({ authedPage: page }) => {
    const form = new StartRecipeFormPage(page);
    await form.openFromContact(page, ids.orgId, ids.contactId);
    await expect(form.person()).toContainText('E2E Departing Person');
    await expect(form.cutoffHelp()).toBeVisible();

    await form.inheritorMode('address').click();
    await form.inheritorAddress().fill('e2e-inheritor@example.com');
    await form.previewButton().click();

    await expect(form.preview()).toBeVisible({ timeout: 30_000 });
    // Only Google is connected, so the automated steps the preview lists are
    // grouped under the Google provider (never numbered: the unit suite pins that).
    await expect(form.previewProvider('google')).toBeVisible();
    await expect(form.submit()).toBeEnabled();
  });

  test('submitting starts the task and lands on its page', async () => {
    // Observed on the e2e stack (2026-10-23): admission answers "no Microsoft
    // 365 or Google Workspace account was found … (google lookup failed
    // (Service-account key is not valid JSON.))", and the form shows it.
    test.skip(true, 'Admission needs a provider account the placeholder Google connection cannot resolve (no_provider_account); needs real provider credentials. Covered against real Postgres by aiOperatorIdentityAdmission.integration.test.ts.');
  });

  test('the task page renders the step list and the plan through the real task read', async ({ authedPage: page }) => {
    const panels = new OperatorTaskPanelsPage(page);
    await panels.goto(ids.taskId);
    await expect(panels.steps()).toBeVisible();
    await expect(panels.step('effects')).toBeVisible();
    await expect(panels.step('intake')).toBeVisible();

    await panels.tab('plan').click();
    await expect(panels.plan()).toBeVisible();
    await expect(panels.planRevision(1)).toBeVisible();
    await expect(panels.planProvider('google')).toBeVisible();
    await expect(panels.planEffect(0)).toBeVisible();
    await expect(panels.planEffect(1)).toBeVisible();

    await panels.tab('events').click();
    await expect(page.getByTestId('task-events-empty').or(panels.events())).toBeVisible();
  });
});

/**
 * identity_onboarding web surface (W07 R2b, #6172). Same file, same seed,
 * `data-testid` only.
 *
 * NEEDS, on top of the offboarding flags above, the stack's untracked env to
 * set AI_OPERATOR_RECIPE_IDENTITY_ONBOARDING_ENABLED=true (with it off the
 * onboarding card reads `unavailable` and both launchers hide by design).
 *
 * THIS RUN STOPS BEFORE ANY CREATION IS APPROVED, and must stay that way:
 * dispatching a real create needs the fake provider executors the integration
 * suite wires (aiOperatorIdentityOnboardingE2E.integration.test.ts), and an
 * e2e that approved an account creation against a stack would be creating
 * identities in a test. Do not "complete" it.
 *
 * Legs past the card SKIP WITH THE OBSERVED REASON when this stack cannot
 * take them (R1b precedent): readiness is never faked, and no seed marks a
 * fake connection healthy beyond the placeholder Google row the offboarding
 * legs already use.
 */
// Unique per run: admission CREATES a contact for this address, so a fixed
// address would make every later run on the same stack a 409.
const NEW_HIRE_UPN = `e2e-new-hire-${Date.now().toString(36)}@example.com`;
const SKU_PLACEHOLDER = 'aaaaaaaa-0000-4000-8000-000000000001';
const GROUP_PLACEHOLDER = 'bbbbbbbb-0000-4000-8000-000000000001';

test.describe('Operator Recipe Library — onboarding', () => {
  let onboardingReadiness: string | null = null;
  let startedTaskId: string | null = null;

  test.beforeAll(() => {
    // Shares the offboarding seed's org; re-running the seed is idempotent.
    const out = psqlFile('seed-operator-recipe-library.sql');
    const orgId = new RegExp('ORG_ID=([0-9a-f-]{36})').exec(out)?.[1];
    if (!orgId) throw new Error(`seed did not report ORG_ID:\n${out}`);
    ids = { ...(ids ?? { contactId: '', taskId: '' }), orgId };
  });

  test.afterAll(() => {
    psql(`SELECT set_config('breeze.scope','system',false); DELETE FROM google_workspace_connections WHERE service_account_key = 'e2e-placeholder-not-a-key';`);
  });

  test('the Library shows the onboarding card, its readiness chip and its hand-work line', async ({ authedPage: page }) => {
    const library = new OperatorLibraryPage(page);
    await library.pinOrg(ids.orgId);
    await library.gotoLibrary();
    await expect(library.card('identity_onboarding')).toBeVisible({ timeout: 30_000 });
    await expect(library.readiness('identity_onboarding')).toBeVisible();
    onboardingReadiness = await library.readiness('identity_onboarding').getAttribute('data-readiness');
    // Google account creation is always manual (D-R2-3), so the card always names hand work.
    await expect(library.manualCount('identity_onboarding')).toBeVisible();
  });

  test('from the org contacts page: fill the new person, preview two labelled approval stages, submit, land on the task', async ({ authedPage: page }) => {
    test.skip(onboardingReadiness === 'unavailable', 'Observed: the onboarding card reads `unavailable` on this stack, which hides both launchers by design (the identity flag or provider connection is missing). Covered by OnboardPersonLauncher / ContactsCard / TicketWorkbench unit MOUNT tests.');
    const form = new StartRecipeFormPage(page);
    await form.openOnboardingFromOrg(page, ids.orgId);
    await expect(form.form()).toHaveAttribute('data-recipe-key', 'identity_onboarding');

    await form.displayName().fill('E2E New Hire');
    await form.provider('m365').click();
    await form.upn().fill(NEW_HIRE_UPN);
    await form.usageLocation().fill('GB');
    await form.skuInput().fill(SKU_PLACEHOLDER);
    await form.skuAdd().click();
    await form.groupInput().fill(GROUP_PLACEHOLDER);
    await form.groupAdd().click();
    await form.previewButton().click();

    await expect(form.preview()).toBeVisible({ timeout: 30_000 });
    // Both stages are always rendered; what proves the draft ran is the requested
    // sign-in name in stage 1 (or the name-check flag when nothing could be created).
    await expect(form.previewStage(1)).toBeVisible();
    await expect(form.previewStage(2)).toBeVisible();
    await expect(form.preview()).toContainText(NEW_HIRE_UPN);
    await expect(form.submit()).toBeEnabled();

    // A refusal here is a FAILURE, not a skip: on a stack where the card is not
    // `unavailable`, admission has everything it needs (it creates the contact
    // and reads no provider). Observed passing on the R2b wt-stack 2026-10-25.
    await form.submit().click();
    // Both waits are settled (the loser resolves to 'timeout'), so neither leaves a rejection behind.
    const outcome = await Promise.race([
      page.waitForURL(/\/operator\/tasks\/[0-9a-f-]{36}/, { timeout: 30_000 }).then(() => 'task' as const, () => 'timeout' as const),
      form.error().waitFor({ timeout: 30_000 }).then(() => 'error' as const, () => 'timeout' as const),
    ]);
    if (outcome === 'error') throw new Error(`admission refused: "${(await form.error().textContent())?.trim() ?? ''}"`);
    expect(outcome).toBe('task');
    startedTaskId = /\/operator\/tasks\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? null;
    expect(startedTaskId).not.toBeNull();
  });

  test('the new task page renders its steps and its (empty) plan through the real task read, with no accounts tab yet', async ({ authedPage: page }) => {
    test.skip(startedTaskId === null, 'No onboarding task was started on this stack (see the previous leg\'s skip reason).');
    const panels = new OperatorTaskPanelsPage(page);
    await panels.goto(startedTaskId!);
    // Freshly admitted: the coordinator may not have opened a step yet, and no
    // plan exists before `discover` — either state is the real read, not a stub.
    await expect(panels.steps().or(page.getByTestId('task-steps-empty'))).toBeVisible();
    await panels.tab('plan').click();
    await expect(page.getByTestId('task-plan-empty')).toBeVisible();
    // No account exists yet, so the accounts tab is absent (it appears only with accounts).
    await expect(panels.tab('accounts')).toHaveCount(0);
    test.info().annotations.push({
      type: 'not covered here',
      description: 'Past `intake` needs a model key (blank on e2e stacks by rule) and an approved creation (never done in e2e): '
        + 'confirm_details, the creation approval and #panel=accounts are covered by the OperatorTaskSteps / OperatorTaskPlan / '
        + 'OperatorTaskDetail unit tests.',
    });
  });
});
