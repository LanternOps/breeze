import { describe, expect, it } from 'vitest';
import { toolInputSchemas } from './aiToolSchemas';
import { registerPolicyPrereqTools } from './aiToolsPolicyPrereqs';

describe('manage_backup_configs provider', () => {
  const schema = toolInputSchemas['manage_backup_configs']!;

  it.each(['s3', 'local'])('accepts %s, the providers a backup destination can use', (provider) => {
    expect(schema.safeParse({ action: 'create', name: 'd', type: 'file', provider }).success).toBe(true);
  });

  it.each(['azure_blob', 'google_cloud', 'backblaze'])('refuses %s', (provider) => {
    expect(schema.safeParse({ action: 'create', name: 'd', type: 'file', provider }).success).toBe(false);
  });

  it('advertises only s3 and local in the tool definition', () => {
    const tools = new Map<string, any>();
    registerPolicyPrereqTools(tools);
    const def = tools.get('manage_backup_configs')!.definition;
    expect(def.input_schema.properties.provider.enum).toEqual(['s3', 'local']);
  });
});

describe('manage_backup_configs local destination path', () => {
  const schema = toolInputSchemas['manage_backup_configs']!;

  it.each(['\\\\nas\\breeze', '//nas/breeze', '\\\\?\\UNC\\nas\\breeze'])('refuses a local destination on %s', (path) => {
    const result = schema.safeParse({ action: 'create', name: 'd', type: 'file', provider: 'local', providerConfig: { path } });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toMatch(/not supported/);
  });

  it.each([[{ Path: '\\\\nas\\breeze' }], [{ PATH: '\\\\nas\\breeze' }], [{}]])('refuses local settings %j', (providerConfig) => {
    const result = schema.safeParse({ action: 'create', name: 'd', type: 'file', provider: 'local', providerConfig });
    expect(result.success).toBe(false);
  });

  it('accepts a local destination on an attached disk', () => {
    const result = schema.safeParse({ action: 'create', name: 'd', type: 'file', provider: 'local', providerConfig: { path: 'D:\\BreezeBackups' } });
    expect(result.success).toBe(true);
  });
});
