import { describe, it, expect } from 'vitest';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';

const dev = '11111111-1111-4111-8111-111111111111';
const ok = (t: string, i: Record<string, unknown>) => expect(validateToolInput(t, i).success).toBe(true);
const bad = (t: string, i: Record<string, unknown>) => expect(validateToolInput(t, i).success).toBe(false);

describe('W04-D16/D17 Zod bounds mirror REST', () => {
  it('manage_peripheral_policy exposes priority 0..1000 int', () => {
    expect((toolInputSchemas.manage_peripheral_policy as any).shape.priority).toBeDefined();
    ok('manage_peripheral_policy', { action: 'disable', policy_id: dev, priority: 1000 });
    ok('manage_peripheral_policy', { action: 'disable', policy_id: dev, priority: 0 });
    bad('manage_peripheral_policy', { action: 'disable', policy_id: dev, priority: 1001 });
    bad('manage_peripheral_policy', { action: 'disable', policy_id: dev, priority: -1 });
    bad('manage_peripheral_policy', { action: 'disable', policy_id: dev, priority: 1.5 });
  });

  it('registry_operations keyPath<=1024, valueName<=256', () => {
    const base = { action: 'get_value', deviceId: dev };
    ok('registry_operations', { ...base, keyPath: 'k'.repeat(1024), valueName: 'v'.repeat(256) });
    bad('registry_operations', { ...base, keyPath: 'k'.repeat(1025), valueName: 'v' });
    bad('registry_operations', { ...base, keyPath: 'k', valueName: 'v'.repeat(257) });
  });

  it('manage_scheduled_tasks taskName<=512', () => {
    ok('manage_scheduled_tasks', { deviceId: dev, action: 'run', taskName: 't'.repeat(512) });
    bad('manage_scheduled_tasks', { deviceId: dev, action: 'run', taskName: 't'.repeat(513) });
  });

  it('manage_processes processId must be digits', () => {
    ok('manage_processes', { action: 'kill', deviceId: dev, processId: '1234' });
    bad('manage_processes', { action: 'kill', deviceId: dev, processId: 'abc' });
    bad('manage_processes', { action: 'kill', deviceId: dev, processId: '-5' });
    bad('manage_processes', { action: 'kill', deviceId: dev, processId: '12.5' });
  });

  it.each(['trigger_agent_restart', 'trigger_agent_upgrade'])('%s deviceIds max 50', (t) => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) =>
      `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`);
    ok(t, { deviceIds: ids(50) });
    bad(t, { deviceIds: ids(51) });
  });

  it('acknowledge_network_device notes<=2000', () => {
    ok('acknowledge_network_device', { event_id: dev, notes: 'n'.repeat(2000) });
    bad('acknowledge_network_device', { event_id: dev, notes: 'n'.repeat(2001) });
  });

  it('configure_network_baseline subnet is route CIDR', () => {
    ok('configure_network_baseline', { subnet: '10.0.0.0/24' });
    bad('configure_network_baseline', { subnet: 'not-a-cidr' });
    bad('configure_network_baseline', { subnet: '10.0.0.0' });
  });
});
