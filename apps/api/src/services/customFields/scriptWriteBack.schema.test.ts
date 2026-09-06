import { describe, it, expect } from 'vitest';
import { CORE_TENANT_EXPORT_POLICY } from '../tenantExportPolicyRegistry';
import { customFieldDefinitions } from '../../db/schema/customFields';
import { scriptExecutions } from '../../db/schema/scripts';

describe('script custom-field write-back schema', () => {
  it('exposes scriptWrite on custom_field_definitions', () => {
    expect(customFieldDefinitions.scriptWrite.name).toBe('script_write');
  });

  it('exposes customFieldResult on script_executions', () => {
    expect(scriptExecutions.customFieldResult.name).toBe('custom_field_result');
  });

  it('classifies script_write as included in the export policy', () => {
    const policy = CORE_TENANT_EXPORT_POLICY['custom_field_definitions'];
    expect(policy?.columns['script_write']?.decision).toBe('include');
  });

  it('classifies custom_field_result as an excluded open container', () => {
    const policy = CORE_TENANT_EXPORT_POLICY['script_executions'];
    // Every json/jsonb/bytea column is excludedOpen — no exceptions.
    const decision = policy?.columns['custom_field_result'];
    expect(decision?.decision).toBe('exclude');
    expect(decision?.openContainerReviewed).toBe(true);
  });
});
