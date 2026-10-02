import { describe, expect, it } from 'vitest';
import { AI_CHARGEBACK_ELIGIBLE_SURFACES, AI_SURFACES, AI_SURFACE_ROLES, TOOL_REQUIRING_SURFACES } from '../index';

describe('AI surfaces (index contract)', () => {
  it('pins the surface list', () => {
    expect(AI_SURFACES).toEqual([
      'chat', 'helper', 'script_builder', 'script_reviewer', 'office_chat',
      'office_ticket', 'ai_agents', 'catalog_enrichment', 'extension_content', 'patch_test',
    ]);
  });
  it('gives every surface a default role, and ai_agents the escalation roles', () => {
    for (const surface of AI_SURFACES) expect(AI_SURFACE_ROLES[surface]).toContain('default');
    expect(AI_SURFACE_ROLES.ai_agents).toEqual(['default', 'triage', 'analysis', 'remediation']);
    expect(Object.keys(AI_SURFACE_ROLES).sort()).toEqual([...AI_SURFACES].sort());
  });
  it('tool-requiring surfaces are a subset of the surfaces', () => {
    expect(TOOL_REQUIRING_SURFACES).toEqual(['chat', 'helper', 'script_builder', 'ai_agents', 'office_chat']);
    for (const surface of TOOL_REQUIRING_SURFACES) expect(AI_SURFACES).toContain(surface);
  });
});

describe('AI_CHARGEBACK_ELIGIBLE_SURFACES (#7608)', () => {
  it('is a subset of AI_SURFACES', () => {
    for (const s of AI_CHARGEBACK_ELIGIBLE_SURFACES) expect(AI_SURFACES).toContain(s);
  });
  it('excludes the MSP-internal tooling surfaces', () => {
    expect(AI_CHARGEBACK_ELIGIBLE_SURFACES).not.toContain('catalog_enrichment');
    expect(AI_CHARGEBACK_ELIGIBLE_SURFACES).not.toContain('extension_content');
    expect(AI_CHARGEBACK_ELIGIBLE_SURFACES).not.toContain('patch_test');
  });
  it('includes every client-work surface', () => {
    expect([...AI_CHARGEBACK_ELIGIBLE_SURFACES].sort()).toEqual(
      ['ai_agents', 'chat', 'helper', 'office_chat', 'office_ticket', 'script_builder', 'script_reviewer'],
    );
  });
});
