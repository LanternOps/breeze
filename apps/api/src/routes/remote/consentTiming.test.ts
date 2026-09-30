import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_CONSENT_HELPER_WAIT_MS,
  AGENT_CONSENT_IPC_GRACE_MS,
  AGENT_CONSENT_PRESENT_BUDGET_MS,
  DESKTOP_CONSENT_TIMEOUT_MS,
  VIEWER_BASE_ANSWER_TIMEOUT_MS,
  consentDeniedMessage,
  viewerAnswerTimeoutMs,
} from './consentTiming';

// #6818: the viewer gave up on the agent's answer after 15s while the agent was
// still (correctly) holding it behind a 30s consent dialog.
describe('viewerAnswerTimeoutMs', () => {
  it('keeps the base budget for a session with no end-user prompt', () => {
    expect(viewerAnswerTimeoutMs('off')).toBe(VIEWER_BASE_ANSWER_TIMEOUT_MS);
    expect(viewerAnswerTimeoutMs(null)).toBe(VIEWER_BASE_ANSWER_TIMEOUT_MS);
  });

  it('covers an on-demand helper spawn for a notify-mode session', () => {
    expect(viewerAnswerTimeoutMs('notify')).toBe(VIEWER_BASE_ANSWER_TIMEOUT_MS + AGENT_CONSENT_HELPER_WAIT_MS);
  });

  it('covers the helper spawn, the prompt coming up, the whole consent dialog and the agent IPC grace in consent mode', () => {
    // The dialog's countdown starts only once the prompt is on screen, so the
    // budget also covers the time the agent allows for the prompt to appear.
    expect(viewerAnswerTimeoutMs('consent')).toBe(
      VIEWER_BASE_ANSWER_TIMEOUT_MS
        + AGENT_CONSENT_HELPER_WAIT_MS
        + AGENT_CONSENT_PRESENT_BUDGET_MS
        + DESKTOP_CONSENT_TIMEOUT_MS
        + AGENT_CONSENT_IPC_GRACE_MS,
    );
  });

  it('always outlasts the consent dialog the end user sees', () => {
    expect(viewerAnswerTimeoutMs('consent')).toBeGreaterThan(DESKTOP_CONSENT_TIMEOUT_MS + AGENT_CONSENT_HELPER_WAIT_MS);
  });

  it('stays under the viewer cap (MAX_ANSWER_TIMEOUT_MS in apps/viewer/src/lib/answerPoll.ts)', () => {
    expect(viewerAnswerTimeoutMs('consent')).toBeLessThan(180_000);
  });
});

describe('consentDeniedMessage', () => {
  it.each([
    ['user', /declined/],
    ['timeout', /did not respond/],
    ['helper_absent', /could be asked/],
    ['no_user_session', /no one is signed in/i],
    ['helper_unreachable', /could not be shown/],
    ['no_user', /could not be approved/],
    ['something-new', /could not be approved/],
  ])('gives the technician a specific reason for %s', (reason, pattern) => {
    expect(consentDeniedMessage(reason)).toMatch(pattern);
  });

  it('does not blame Breeze Assist when the user could not see the prompt or no prompt is available', () => {
    expect(consentDeniedMessage('helper_unreachable', 'prompt_not_visible')).toMatch(/could not see the consent prompt/);
    expect(consentDeniedMessage('helper_unreachable', 'prompt_not_visible')).not.toMatch(/Assist/);
    expect(consentDeniedMessage('helper_unreachable', 'no_helper')).toMatch(/no way to show/);
  });

  it('says another request is waiting when the prompt was refused because one is already on screen', () => {
    expect(consentDeniedMessage('helper_unreachable', 'prompt_in_progress')).toMatch(/already waiting/);
    // Any other detail keeps the reason's message.
    expect(consentDeniedMessage('helper_unreachable', 'no_presentation')).toMatch(/could not be shown/);
    expect(consentDeniedMessage('user', 'prompt_in_progress')).toMatch(/declined/);
  });
});

// The agent-side values are mirrored, not shared (Go vs TypeScript). Read the
// Go source so a change on one side without the other fails here, in the
// required Test API job, instead of silently re-opening #6818.
describe('agent constant mirrors', () => {
  const heartbeatDir = path.resolve(__dirname, '../../../../../agent/internal/heartbeat');
  const goSource = (file: string) => readFileSync(path.join(heartbeatDir, file), 'utf8');

  it('AGENT_CONSENT_IPC_GRACE_MS matches consentTimeoutGraceMs in consent_gate.go', () => {
    const match = goSource('consent_gate.go').match(/const consentTimeoutGraceMs = (\d+)/);
    expect(match, 'consentTimeoutGraceMs not found in consent_gate.go').not.toBeNull();
    expect(Number(match![1])).toBe(AGENT_CONSENT_IPC_GRACE_MS);
  });

  it('AGENT_CONSENT_PRESENT_BUDGET_MS matches consentPresentBudgetMs in consent_gate.go', () => {
    const match = goSource('consent_gate.go').match(/const consentPresentBudgetMs = (\d+)/);
    expect(match, 'consentPresentBudgetMs not found in consent_gate.go').not.toBeNull();
    expect(Number(match![1])).toBe(AGENT_CONSENT_PRESENT_BUDGET_MS);
  });

  it('AGENT_CONSENT_HELPER_WAIT_MS matches consentHelperWait in handlers_desktop_lease.go', () => {
    const match = goSource('handlers_desktop_lease.go').match(/consentHelperWait = (\d+) \* time\.Second/);
    expect(match, 'consentHelperWait not found in handlers_desktop_lease.go').not.toBeNull();
    expect(Number(match![1]) * 1000).toBe(AGENT_CONSENT_HELPER_WAIT_MS);
  });
});
