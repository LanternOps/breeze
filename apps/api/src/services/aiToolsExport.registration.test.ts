import { describe, it, expect } from 'vitest';
import { aiTools } from './aiTools';
import { TOOL_TIERS, BREEZE_MCP_TOOL_NAMES } from './aiAgentSdkTools';
import { AGENT_CAPABILITIES, TOOL_CAPABILITY } from './aiAgents/agentToolCatalog';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS } from './aiGuardrails';
import { readFileSync } from 'node:fs';
import { DATASET_ADAPTERS, EXPORT_DATASETS } from './aiToolsExportDatasets';
import { EXPORT_DATASETS as LEAF_EXPORT_DATASETS } from './aiToolsExportDatasetNames';
import { EXPORT_DATASET_REQUIREMENTS } from './aiToolsExportPermissions';

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('export_dataset registration', () => {
  it('1. is in the aiTools registry', () => {
    expect(aiTools.has('export_dataset')).toBe(true);
  });

  it('2. is in TOOL_TIERS at tier 1', () => {
    expect(TOOL_TIERS.export_dataset).toBe(1);
  });

  it('3. is mapped to the workspace capability, which exists', () => {
    expect(TOOL_CAPABILITY.export_dataset).toBe('workspace');
    expect(AGENT_CAPABILITIES.map((c) => c.id)).toContain('workspace');
    expect(AGENT_CAPABILITIES.find((c) => c.id === 'workspace')?.tone).toBe('standard');
  });

  it('4a. is advertised under the SDK-prefixed MCP name', () => {
    // BREEZE_MCP_TOOL_NAMES is `Object.keys(TOOL_TIERS).map(n => 'mcp__breeze__' + n)`
    // (aiAgentSdkTools.ts:335), so the bare name never appears — and this
    // assertion alone only re-tests TOOL_TIERS, which is why 4b exists.
    expect(BREEZE_MCP_TOOL_NAMES).toContain('mcp__breeze__export_dataset');
  });

  it('4b. has a real tool() declaration inside buildBreezeSdkTools (A-W02 extracted it from createBreezeMcpServer)', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./aiAgentSdkTools.ts', import.meta.url), 'utf8'));
    const server = source.slice(source.indexOf('export function buildBreezeSdkTools'));
    expect(server).toContain("'export_dataset'");
    expect(server).toContain("makeHandler('export_dataset'");
  });

  it('5. has a Zod input schema', () => {
    expect('export_dataset' in toolInputSchemas).toBe(true);
    const parsed = toolInputSchemas.export_dataset!.safeParse({ dataset: 'event_logs', format: 'csv' });
    expect(parsed.success).toBe(true);
    expect(toolInputSchemas.export_dataset!.safeParse({ dataset: 'nope' }).success).toBe(false);
  });

  it('6. has an RBAC permission entry', () => {
    expect(TOOL_PERMISSIONS.export_dataset).toEqual({ resource: 'devices', action: 'read' });
  });
});

describe('export_dataset dataset lists cannot drift', () => {
  it('the hub re-exports the leaf list unchanged', () => {
    expect(EXPORT_DATASETS).toBe(LEAF_EXPORT_DATASETS);
  });

  it('both Zod enums derive from EXPORT_DATASETS', () => {
    const schema = toolInputSchemas.export_dataset as unknown as { shape: { dataset: { options: string[] } } };
    expect(schema.shape.dataset.options).toEqual([...EXPORT_DATASETS]);
    for (const file of ['./aiToolSchemas.ts', './aiAgentSdkTools.ts']) {
      expect(src(file)).toContain('dataset: z.enum(EXPORT_DATASETS)');
      expect(src(file)).not.toMatch(/dataset: z\.enum\(\['event_logs'/);
    }
  });

  it('adapters, requirements, description and docs name every dataset', () => {
    expect(Object.keys(DATASET_ADAPTERS).sort()).toEqual([...EXPORT_DATASETS].sort());
    expect(Object.keys(EXPORT_DATASET_REQUIREMENTS).sort()).toEqual([...EXPORT_DATASETS].sort());
    const description = aiTools.get('export_dataset')!.definition.description;
    const docs = src('../../../docs/src/content/docs/features/ai-tools.mdx');
    for (const name of EXPORT_DATASETS) {
      expect(description).toContain(name);
      expect(docs).toContain(`\`${name}\``);
    }
  });
});
