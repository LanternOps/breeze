import { describe, expect, it } from 'vitest';
import { aiTools } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { softwareToolSchemas } from './aiToolSchemasSoftware';

/**
 * Full-control W12 (#6782): the W12 tool schemas. Pins what the W12 plan left
 * OUT ("Not built" + quorum QW3/QW5) so a later edit cannot quietly add it, and
 * keeps every Zod schema's keys and action enum equal to the registry's
 * `input_schema` (the model sees the registry; the validator enforces Zod).
 */
const W12 = Object.keys(softwareToolSchemas) as Array<keyof typeof softwareToolSchemas>;

function registryProps(name: string): Record<string, { enum?: unknown[] }> {
  return ((aiTools.get(name)!.definition.input_schema as { properties?: Record<string, { enum?: unknown[] }> }).properties) ?? {};
}

describe('W12 schemas (#6782)', () => {
  it('are the nine W12 tools, all merged into toolInputSchemas', () => {
    expect([...W12].sort()).toEqual([
      'bootstrap_homebrew', 'get_device_software', 'manage_custom_fields', 'manage_device_software', 'manage_fleet_findings',
      'manage_software_catalog', 'manage_software_deployments', 'manage_software_inventory', 'search_packages',
    ]);
    for (const name of W12) expect(toolInputSchemas[name]).toBe(softwareToolSchemas[name]);
  });

  it.each(W12)('%s: Zod keys === registry keys, and the action enums agree', (name) => {
    const shape = softwareToolSchemas[name].shape as Record<string, unknown>;
    expect(Object.keys(shape).sort()).toEqual(Object.keys(registryProps(name)).sort());
    const zodAction = (shape.action as { options?: readonly string[] } | undefined)?.options;
    expect(zodAction ? [...zodAction] : undefined).toEqual(registryProps(name).action?.enum);
    expect((aiTools.get(name)!.definition.input_schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });

  it('no download-url reader, no version upload, no install scripts in the catalog tool (plan "Not built", QW5)', () => {
    const shape = softwareToolSchemas.manage_software_catalog.shape;
    expect(shape.action.options).not.toEqual(expect.arrayContaining(['download_url']));
    for (const action of ['download_url', 'upload_version', 'delete_version']) expect(shape.action.options).not.toContain(action);
    for (const key of ['preInstallScript', 'postInstallScript', 's3Key']) expect(Object.keys(shape)).not.toContain(key);
  });

  it('a deployment targets named devices only: no groups, all, filter or sites; at most 100 (quorum QW3)', () => {
    const shape = softwareToolSchemas.manage_software_deployments.shape;
    for (const key of ['targetType', 'targetIds', 'targetFilter', 'groupIds']) expect(Object.keys(shape)).not.toContain(key);
    const deviceIds = shape.deviceIds;
    expect(deviceIds.safeParse(Array.from({ length: 100 }, () => '00000000-0000-4000-8000-000000000000')).success).toBe(true);
    expect(deviceIds.safeParse(Array.from({ length: 101 }, () => '00000000-0000-4000-8000-000000000000')).success).toBe(false);
    expect(shape.action.options).not.toContain('deploy');
  });

  it('fleet findings: no remediate action', () => {
    expect(softwareToolSchemas.manage_fleet_findings.shape.action.options).toEqual(['acknowledge', 'dismiss', 'reopen']);
  });

  it('rejects unknown keys (strict)', () => {
    expect(softwareToolSchemas.bootstrap_homebrew.safeParse({ deviceId: '00000000-0000-4000-8000-000000000000', installerUrl: 'x' }).success).toBe(false);
  });
});
