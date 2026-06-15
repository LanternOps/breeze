import { describe, it, expect } from 'vitest';
import { isGlobalScopeRoute } from './routeScope';

describe('isGlobalScopeRoute', () => {
  it('treats the script library, new, and detail routes as global', () => {
    expect(isGlobalScopeRoute('/scripts')).toBe(true);
    expect(isGlobalScopeRoute('/scripts/')).toBe(true);
    expect(isGlobalScopeRoute('/scripts/new')).toBe(true);
    expect(isGlobalScopeRoute('/scripts/abc-123')).toBe(true);
  });
  it('treats patch surfaces as global (org comes from the ring)', () => {
    expect(isGlobalScopeRoute('/patches')).toBe(true);
    expect(isGlobalScopeRoute('/patches/anything')).toBe(true);
  });
  it('treats alert templates as global', () => {
    expect(isGlobalScopeRoute('/alert-templates')).toBe(true);
  });
  it('treats script execution history as org-scoped (exception)', () => {
    // Execution history lives at /scripts/:id/executions (not /scripts/executions)
    expect(isGlobalScopeRoute('/scripts/abc-123/executions')).toBe(false);
  });
  it('treats device/state routes as scoped', () => {
    expect(isGlobalScopeRoute('/')).toBe(false);
    expect(isGlobalScopeRoute('/devices')).toBe(false);
    expect(isGlobalScopeRoute('/alerts')).toBe(false);
  });
});
