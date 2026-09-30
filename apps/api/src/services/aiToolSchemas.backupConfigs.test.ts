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
