import Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());
const catalog = vi.hoisted(() => ({ enabled: true }));
vi.mock('./connectionFactory', () => ({ createAnthropicClient: vi.fn(() => ({ messages: { create } })) }));
vi.mock('../../db', () => ({ runOutsideDbContext: (fn: () => unknown) => fn() }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('../aiModel', () => ({ resolveDefaultModel: () => 'model-default' }));
vi.mock('../llmProviderCatalog', () => ({ getListedProviderByEntryId: vi.fn() }));
vi.mock('../llm/llmConfigResolver', () => ({
  isLlmProviderCatalogEnabled: vi.fn(() => catalog.enabled),
  buildCatalogEndpointSnapshot: vi.fn(),
}));

import { LlmEgressViolationError } from '../llm/guardedLlmFetch';
import { buildCatalogEndpointSnapshot, type ResolvedLlmEndpoint } from '../llm/llmConfigResolver';
import { getListedProviderByEntryId } from '../llmProviderCatalog';
import { captureException } from '../sentry';
import { createAnthropicClient } from './connectionFactory';
import { ConnectionCheckError, probeAnthropicKey, resolveCatalogEndpointForSelection } from './connectionProbe';

const apiError = (status: number) => new Anthropic.APIError(status, {}, 'x', new Headers());
const catalogEndpoint = {
  kind: 'catalog', baseUrl: 'https://gw.example/v1', authMode: 'x-api-key', providerModel: 'gw/model-chat',
} as unknown as ResolvedLlmEndpoint;

beforeEach(() => {
  vi.clearAllMocks();
  catalog.enabled = true;
});

describe('probeAnthropicKey', () => {
  it.each([
    [401, 400, 'That Anthropic API key was rejected'],
    [403, 409, 'Anthropic denied access'],
    [404, 400, 'Anthropic rejected the verification request (HTTP 404)'],
    [429, 503, 'could not verify the API key right now'],
    [500, 503, 'could not verify the API key right now'],
  ])('maps an Anthropic %s to ConnectionCheckError %s', async (status, mapped, text) => {
    create.mockRejectedValueOnce(apiError(status));
    const err = await probeAnthropicKey('sk-ant-x').catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionCheckError);
    expect(err.status).toBe(mapped);
    expect(err.message).toContain(text);
  });

  it('reports an unexpected 4xx to Sentry under the moved service tag', async () => {
    const upstream = apiError(404);
    create.mockRejectedValueOnce(upstream);
    await probeAnthropicKey('sk-ant-x').catch(() => undefined);
    expect(captureException).toHaveBeenCalledWith(upstream, undefined, { service: 'aiModels.connectionProbe' });
  });

  it('a blocked egress is a transient 503, not a key rejection', async () => {
    create.mockRejectedValueOnce(new LlmEgressViolationError('blocked'));
    await expect(probeAnthropicKey('sk-ant-x')).rejects.toMatchObject({ status: 503 });
  });

  it('a programming error is rethrown unwrapped', async () => {
    create.mockRejectedValueOnce(new TypeError('bug'));
    await expect(probeAnthropicKey('sk-ant-x')).rejects.toBeInstanceOf(TypeError);
  });

  it('probes direct Anthropic with the deployment default model and max_tokens 1', async () => {
    create.mockResolvedValueOnce({});
    await probeAnthropicKey('sk-ant-x');
    expect(createAnthropicClient).toHaveBeenCalledWith({ apiKey: 'sk-ant-x', target: { kind: 'anthropic' } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'model-default', max_tokens: 1 }));
  });

  it('probes a catalog endpoint through the guarded target with its provider model; an unauditable egress warns once', async () => {
    create.mockResolvedValueOnce({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await probeAnthropicKey('sk-ant-x', catalogEndpoint);
    const spec = vi.mocked(createAnthropicClient).mock.calls[0]![0];
    expect(spec.target).toMatchObject({ kind: 'endpoint', baseUrl: 'https://gw.example/v1', authMode: 'x-api-key' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gw/model-chat', max_tokens: 1 }));
    const record = (spec.target as { recordEgress: (a: unknown) => void }).recordEgress;
    record({ host: 'gw.example', resolvedIp: null, blocked: false });
    record({ host: 'gw.example', resolvedIp: null, blocked: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('[aiModels]');
    warn.mockRestore();
  });
});

describe('resolveCatalogEndpointForSelection', () => {
  it('a disabled catalog, a delisted entry and an unmapped model are each a 409 ConnectionCheckError', async () => {
    catalog.enabled = false;
    await expect(resolveCatalogEndpointForSelection('e1', 'm')).rejects.toMatchObject({ name: 'ConnectionCheckError', status: 409 });
    catalog.enabled = true;
    vi.mocked(getListedProviderByEntryId).mockResolvedValueOnce(null);
    await expect(resolveCatalogEndpointForSelection('e1', 'm')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('delisted') });
    vi.mocked(getListedProviderByEntryId).mockResolvedValueOnce({ entryId: 'e1' } as never);
    vi.mocked(buildCatalogEndpointSnapshot).mockReturnValueOnce(null);
    await expect(resolveCatalogEndpointForSelection('e1', 'm')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('does not currently support') });
  });

  it('returns the endpoint snapshot for the entry and model', async () => {
    vi.mocked(getListedProviderByEntryId).mockResolvedValueOnce({ entryId: 'e1' } as never);
    vi.mocked(buildCatalogEndpointSnapshot).mockReturnValueOnce(catalogEndpoint as never);
    await expect(resolveCatalogEndpointForSelection('e1', 'model-chat')).resolves.toBe(catalogEndpoint);
    expect(buildCatalogEndpointSnapshot).toHaveBeenCalledWith({ entryId: 'e1' }, 'model-chat');
  });
});
