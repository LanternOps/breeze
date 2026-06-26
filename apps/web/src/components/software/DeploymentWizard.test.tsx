import { describe, it, expect } from 'vitest';
import { extractDeployFailure } from './DeploymentWizard';

// The deploy endpoint returns HTTP 200 with { data: { status: 'failed', message } }
// when a built-in EDR deploy can't proceed (org unmapped / integration disconnected).
// runAction passes that body through as success, so the wizard relies on this helper
// to surface it. Guard against a silent-success regression.
describe('extractDeployFailure', () => {
  it('returns the message when the server failed the deployment', () => {
    expect(extractDeployFailure({ id: 'd1', status: 'failed', message: 'Organization not mapped to Huntress' }))
      .toBe('Organization not mapped to Huntress');
  });

  it('falls back to a generic message when status is failed but no message', () => {
    expect(extractDeployFailure({ status: 'failed' })).toBe('Deployment failed');
  });

  it('returns null for a normal success body', () => {
    expect(extractDeployFailure({ id: 'd1' })).toBeNull();
    expect(extractDeployFailure({ id: 'd1', status: 'pending' })).toBeNull();
    expect(extractDeployFailure(null)).toBeNull();
    expect(extractDeployFailure(undefined)).toBeNull();
  });
});
