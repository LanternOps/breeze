import { describe, it, expect } from 'vitest';
import { isGlobalScopeRoute } from './routeScope';

describe('isGlobalScopeRoute', () => {
  it('treats the script library, new, and detail routes as global', () => {
    expect(isGlobalScopeRoute('/scripts')).toBe(true);
    expect(isGlobalScopeRoute('/scripts/')).toBe(true);
    expect(isGlobalScopeRoute('/scripts/new')).toBe(true);
    expect(isGlobalScopeRoute('/scripts/abc-123')).toBe(true);
  });
  it('treats patch surfaces as org-scoped so the switcher applies (single-org actions need an explicit orgId)', () => {
    expect(isGlobalScopeRoute('/patches')).toBe(false);
    expect(isGlobalScopeRoute('/patches/anything')).toBe(false);
  });
  it('treats alert templates as global', () => {
    expect(isGlobalScopeRoute('/alert-templates')).toBe(true);
  });
  it('treats the settings alert-template catalog (list/new/edit) as global (#1425)', () => {
    expect(isGlobalScopeRoute('/settings/alert-templates')).toBe(true);
    expect(isGlobalScopeRoute('/settings/alert-templates/new')).toBe(true);
    expect(isGlobalScopeRoute('/settings/alert-templates/abc-123')).toBe(true);
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
