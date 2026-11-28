import { describe, expect, it } from 'vitest';

import { openApiSpec } from './openapi';

describe('pre-assignment OpenAPI registration', () => {
  it.each([
    ['/pre-assignment/devices', 'get', 'listParkedDevices'],
    ['/pre-assignment/devices/{id}/assign', 'post', 'assignParkedDevice'],
    ['/pre-assignment/devices/assign-bulk', 'post', 'assignParkedDevicesBulk'],
    ['/pre-assignment/switch', 'post', 'setPreAssignmentSwitch'],
    ['/pre-assignment/deploy-keys/{deployKeyId}/expire-devices', 'post', 'expireDevicesParkedByDeployKey'],
  ])('documents %s %s', (path, method, operationId) => {
    const op = (openApiSpec.paths as unknown as Record<string, Record<string, { operationId: string; tags: readonly string[] }>>)[path]?.[method];
    expect(op, `${method.toUpperCase()} ${path}`).toBeDefined();
    expect(op!.operationId).toBe(operationId);
    expect(op!.tags).toEqual(['Devices']);
  });
});

describe('parked heartbeat signal (#8318 D-1a)', () => {
  it('documents `parked` on the heartbeat response', () => {
    const schemas = (openApiSpec.components as unknown as { schemas: Record<string, { properties: Record<string, { type: string }> }> }).schemas;
    expect(schemas.HeartbeatResponse?.properties.parked?.type).toBe('boolean');
  });
});
