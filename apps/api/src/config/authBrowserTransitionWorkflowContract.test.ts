import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflowPath = fileURLToPath(new URL('../../../../.github/workflows/ci.yml', import.meta.url));

describe('auth browser transition CI fan-in contract', () => {
  it('makes a failed Chromium contract fail ci-success', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const summary = workflow.slice(workflow.indexOf('  ci-success:'), workflow.indexOf('  main-red-alert:'));

    expect(summary).toContain(
      'AUTH_BROWSER_TRANSITION_BROWSER_CONTRACT_RESULT: ${{ needs.auth-browser-transition-browser-contract.result }}',
    );
    expect(summary).toContain(
      '[[ "${AUTH_BROWSER_TRANSITION_BROWSER_CONTRACT_RESULT}" != "success" ]]',
    );
  });
});
