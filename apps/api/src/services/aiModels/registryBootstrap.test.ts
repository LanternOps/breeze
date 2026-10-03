import { AI_SURFACES } from '@breeze/shared';
import { describe, expect, it } from 'vitest';
import { BREEZE_FALLBACK_MODEL } from '../aiModel';
import { ENV_DEFAULT_MODEL_BOOTSTRAP_RATES, mayCreateEnvPlatformModel, pickBootstrapDefaultModelId, planBootstrap } from './registryBootstrap';

describe('planBootstrap', () => {
  const platformRow = { id: 'pm-1', created: false };

  it('covers every AI surface (currently ten)', () => {
    const plan = planBootstrap({ modelId: 'model-a', platformRow, connections: [] });
    expect(AI_SURFACES.length).toBe(10);
    expect(plan.assignments).toHaveLength(AI_SURFACES.length);
  });

  it('a partner with no connection: every surface on the platform offering; only chat allows user choice', () => {
    const plan = planBootstrap({ modelId: 'model-a', platformRow, connections: [] });
    expect(plan.destination).toBe('platform');
    expect(plan.connectionOffering).toBeNull();
    expect(plan.assignments.map((a) => a.surface)).toEqual([...AI_SURFACES]);
    expect(plan.assignments.every((a) => a.target === 'platform')).toBe(true);
    expect(plan.assignments.filter((a) => a.allowUserChoice).map((a) => a.surface)).toEqual(['chat']);
  });

  it('a partner with one copied Anthropic connection is bootstrapped onto it, never onto the platform', () => {
    const plan = planBootstrap({ modelId: 'model-a', platformRow, connections: [{ id: 'conn-1', kind: 'anthropic_byok' }] });
    expect(plan.destination).toBe('connection');
    expect(plan.connectionOffering).toEqual({ connectionId: 'conn-1', source: 'discovered', platformModelId: 'pm-1', enabled: true });
    for (const a of plan.assignments) {
      expect(a.target).toBe(a.surface === 'patch_test' ? 'platform' : 'connection');
    }
  });

  it('a catalog connection gets a catalog offering of the default model (resolved live from the revision)', () => {
    const plan = planBootstrap({ modelId: 'model-a', platformRow, connections: [{ id: 'conn-2', kind: 'catalog' }] });
    expect(plan.connectionOffering).toEqual({ connectionId: 'conn-2', source: 'catalog', platformModelId: null, enabled: true });
  });

  it('a BYOK connection whose model has no platform row gets a disabled, unpriced manual offering (never a guessed rate)', () => {
    const plan = planBootstrap({ modelId: 'vllm-x', platformRow: null, connections: [{ id: 'conn-3', kind: 'anthropic_byok' }] });
    expect(plan.connectionOffering).toEqual({ connectionId: 'conn-3', source: 'manual', platformModelId: null, enabled: false });
    expect(plan.assignments.find((a) => a.surface === 'patch_test')!.target).toBeNull();
  });

  it('more than one Anthropic connection fails closed: no default, neither a guessed connection nor platform funding', () => {
    const plan = planBootstrap({
      modelId: 'model-a', platformRow,
      connections: [{ id: 'c1', kind: 'anthropic_byok' }, { id: 'c2', kind: 'catalog' }],
    });
    expect(plan.destination).toBe('ambiguous');
    for (const a of plan.assignments) expect(a.target).toBe(a.surface === 'patch_test' ? 'platform' : null);
  });

  it('no platform row and no connection: assignments are created with no default (resolver says no_eligible_model)', () => {
    const plan = planBootstrap({ modelId: 'model-a', platformRow: null, connections: [] });
    expect(plan.assignments.every((a) => a.target === null)).toBe(true);
  });
});

describe('pickBootstrapDefaultModelId', () => {
  it('self-host: ANTHROPIC_MODEL wins (the backend may serve nothing else)', () => {
    expect(pickBootstrapDefaultModelId({ hosted: false, env: { ANTHROPIC_MODEL: 'vllm-x' }, platformDefaultModelId: 'model-a' })).toBe('vllm-x');
  });
  it('self-host without ANTHROPIC_MODEL: the operator default row', () => {
    expect(pickBootstrapDefaultModelId({ hosted: false, env: {}, platformDefaultModelId: 'model-a' })).toBe('model-a');
  });
  it('hosted: the operator default wins; the env never overrides it', () => {
    expect(pickBootstrapDefaultModelId({ hosted: true, env: { ANTHROPIC_MODEL: 'vllm-x' }, platformDefaultModelId: 'model-a' })).toBe('model-a');
  });
  it('hosted with no default row: the code fallback, never the env', () => {
    expect(pickBootstrapDefaultModelId({ hosted: true, env: { ANTHROPIC_MODEL: 'vllm-x' }, platformDefaultModelId: null })).toBe(BREEZE_FALLBACK_MODEL);
  });
  it('no env and no default row: the code fallback', () => {
    expect(pickBootstrapDefaultModelId({ hosted: true, env: {}, platformDefaultModelId: null })).toBe(BREEZE_FALLBACK_MODEL);
  });
});

describe('mayCreateEnvPlatformModel', () => {
  it('only the self-hosted ANTHROPIC_MODEL id may create a global platform row', () => {
    expect(mayCreateEnvPlatformModel('vllm-x', { hosted: false, env: { ANTHROPIC_MODEL: 'vllm-x' } })).toBe(true);
    expect(mayCreateEnvPlatformModel('vllm-x', { hosted: true, env: { ANTHROPIC_MODEL: 'vllm-x' } })).toBe(false);
    expect(mayCreateEnvPlatformModel('vllm-x', { hosted: false, env: {} })).toBe(false);
    expect(mayCreateEnvPlatformModel('tenant-typed', { hosted: false, env: { ANTHROPIC_MODEL: 'vllm-x' } })).toBe(false);
  });

  it('the bootstrap rate is the documented Opus-tier over-estimate, never zero', () => {
    expect(ENV_DEFAULT_MODEL_BOOTSTRAP_RATES).toEqual({
      inputCentsPerM: 500, outputCentsPerM: 2500, cacheReadCentsPerM: 50, cacheWriteCentsPerM: 625,
    });
  });
});
