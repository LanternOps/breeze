import { describe, expect, it } from 'vitest';
import { ActionError } from '@/lib/runAction';
import { agentSaveIssuesFromError } from './agentErrors';

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${JSON.stringify(options)})` : key;

function actPrereq(missing: string[]): ActionError {
  return new ActionError('act_prerequisites_not_met', 422, 'act_prerequisites_not_met', { missing });
}

describe('agentSaveIssuesFromError', () => {
  it('returns null for anything that is not an ActionError with a structured body', () => {
    expect(agentSaveIssuesFromError(new Error('boom'), t)).toBeNull();
    expect(agentSaveIssuesFromError(new ActionError('other_code', 400, 'other_code', {}), t)).toBeNull();
  });

  it('maps a missing recipient to "add one" when nothing was selected', () => {
    expect(agentSaveIssuesFromError(actPrereq(['recipient']), t)).toEqual([
      'settings:aiAgentsPage.errors.actMissingRecipient',
    ]);
    expect(agentSaveIssuesFromError(actPrereq(['recipient']), t, { recipientsSelected: false })).toEqual([
      'settings:aiAgentsPage.errors.actMissingRecipient',
    ]);
  });

  it('maps a missing recipient to "the selected roles have no members" when roles WERE selected (#5048 QA)', () => {
    // The server (recipients.ts hasResolvableAgentRecipient) only counts a
    // role with at least one active member — telling the operator to "add a
    // recipient" when they already picked one sent them in circles.
    expect(agentSaveIssuesFromError(actPrereq(['recipient']), t, { recipientsSelected: true })).toEqual([
      'settings:aiAgentsPage.errors.actRecipientsUnreachable',
    ]);
  });

  it('keeps the act-eligible-tool prerequisite and unknown tokens verbatim', () => {
    expect(agentSaveIssuesFromError(actPrereq(['act_eligible_tool', 'something_new']), t, { recipientsSelected: true })).toEqual([
      'settings:aiAgentsPage.errors.actMissingTool',
      'something_new',
    ]);
  });
});
