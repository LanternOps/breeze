import { describe, expect, it, vi } from 'vitest';
import { enqueueTopologyChange, parseLegacyTopologyEvent, type TopologyTransaction, type TopologyChangeInput } from './legacyCapture';

const scope = { orgId: '00000000-0000-4000-8000-000000000001', siteId: '00000000-0000-4000-8000-000000000002' };
const id = '00000000-0000-4000-8000-000000000003';
const identity = { ...scope, sourceId: id };
const event: TopologyChangeInput = { version: 1, sourceTable: 'v2_intents', sourceId: id, oldIdentity: null, newIdentity: identity,
  idempotencyKey: 'intent:1', type: 'node.upsert', data: { label: 'Switch', role: 'switch', notes: null, createdBy: null } };

describe('transactional topology capture protocol', () => {
  it('calls the SQL serializer and preserves bigint revisions', async () => {
    const execute = vi.fn().mockResolvedValue([{ revision: '9007199254740993' }]);
    await expect(enqueueTopologyChange({ execute } as unknown as TopologyTransaction, scope, event)).resolves.toBe('9007199254740993');
    expect(execute).toHaveBeenCalledOnce();
  });
  it('rejects duplicate application capture of trigger-owned sources', async () => {
    const execute = vi.fn();
    await expect(enqueueTopologyChange({ execute } as unknown as TopologyTransaction, scope, { ...event, sourceTable: 'topology_manual_nodes' })).rejects.toThrow(/SQL triggers/);
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects cross-site enqueue before accessing the transaction', async () => {
    const execute = vi.fn();
    await expect(enqueueTopologyChange({ execute } as unknown as TopologyTransaction, { ...scope, siteId: id }, event)).rejects.toThrow(/scope/);
    expect(execute).not.toHaveBeenCalled();
  });
  it('never swallows an outbox failure', async () => {
    const error = new Error('outbox rejected');
    await expect(enqueueTopologyChange({ execute: vi.fn().mockRejectedValue(error) } as unknown as TopologyTransaction, scope, event)).rejects.toBe(error);
  });
  it('parses durable deletion tombstones and layout node references', () => {
    expect(parseLegacyTopologyEvent({ ...event, sourceTable: 'topology_manual_nodes', type: 'node.delete', oldIdentity: identity, newIdentity: null, data: null, sourceRevision: '7' })).toMatchObject({ sourceRevision: '7', data: null });
    expect(parseLegacyTopologyEvent({ ...event, sourceTable: 'topology_layout', type: 'layout.delete', oldIdentity: identity, newIdentity: null, data: { nodeType: 'manual_node', nodeId: id }, sourceRevision: '8' }).type).toBe('layout.delete');
  });
  it.each([
    { sourceRevision: '0' }, { sourceRevision: '9223372036854775808' }, { sourceRevision: '1.0' },
    { data: { ...event.data!, rawInventory: { credentials: 'secret' } } },
    { data: { ...event.data!, notes: 'x'.repeat(8193) } },
    { oldIdentity: null, newIdentity: null }, { sourceTable: 'devices' },
    { newIdentity: { ...identity, sourceId: scope.orgId } },
  ])('rejects malformed or unbounded event %j', patch => {
    expect(() => parseLegacyTopologyEvent({ ...event, sourceRevision: '1', ...patch })).toThrow();
  });
});
