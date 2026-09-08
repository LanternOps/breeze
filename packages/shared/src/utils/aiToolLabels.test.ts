import { describe, expect, it } from 'vitest';
import { aiToolLabel, titleCaseToolName } from './aiToolLabels';

describe('aiToolLabel', () => {
  it('reads as an action, not a symbol', () => {
    // #5107: chat rows read "MANAGE_ALERTS · COMPLETED" / "GET_FLEET_FINDINGS
    // · COMPLETED". A technician should see what happened, not the identifier.
    expect(aiToolLabel('manage_alerts', 'completed')).toBe('Updated alerts');
    expect(aiToolLabel('get_fleet_findings', 'completed')).toBe('Checked fleet findings');
    expect(aiToolLabel('search_logs', 'completed')).toBe('Searched logs');
  });

  it('uses the present tense while the call is in flight', () => {
    expect(aiToolLabel('manage_alerts', 'running')).toBe('Updating alerts');
    expect(aiToolLabel('get_fleet_findings', 'running')).toBe('Checking fleet findings');
    expect(aiToolLabel('search_logs', 'running')).toBe('Searching logs');
  });

  it('conjugates the verb families that actually appear in chat', () => {
    expect(aiToolLabel('run_script', 'completed')).toBe('Ran script');
    expect(aiToolLabel('run_script', 'running')).toBe('Running script');
    expect(aiToolLabel('execute_command', 'completed')).toBe('Ran command');
    expect(aiToolLabel('query_devices', 'completed')).toBe('Searched devices');
    expect(aiToolLabel('list_scripts', 'completed')).toBe('Listed scripts');
    expect(aiToolLabel('analyze_disk_usage', 'completed')).toBe('Analyzed disk usage');
    expect(aiToolLabel('trigger_backup', 'completed')).toBe('Started backup');
    expect(aiToolLabel('remediate_vulnerability', 'completed')).toBe('Remediated vulnerability');
  });

  it('falls back to readable title case for an unknown tool', () => {
    // New tools land constantly; an unmapped one must still read like English
    // rather than reverting to the SCREAMING_SNAKE_CASE this replaced.
    expect(aiToolLabel('disk_cleanup', 'completed')).toBe('Disk cleanup');
    expect(aiToolLabel('network_discovery', 'running')).toBe('Network discovery');
    expect(aiToolLabel('brand_new_tool_nobody_mapped', 'completed')).toBe('Brand new tool nobody mapped');
  });

  it('strips the mcp__server__ prefix the SDK adds', () => {
    expect(aiToolLabel('mcp__breeze__manage_alerts', 'completed')).toBe('Updated alerts');
    expect(aiToolLabel('mcp__script_builder__apply_script_code', 'completed')).toBe('Applied script code');
  });

  it('never returns an empty or raw-underscored label', () => {
    for (const name of ['', '__', 'x', 'get_', 'mcp__breeze__']) {
      const label = aiToolLabel(name, 'completed');
      expect(label).not.toContain('_');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('exposes the plain title-case fallback for callers that want only that', () => {
    expect(titleCaseToolName('get_fleet_findings')).toBe('Get fleet findings');
    expect(titleCaseToolName('mcp__breeze__manage_alerts')).toBe('Manage alerts');
    expect(titleCaseToolName('')).toBe('Tool');
  });

  it('reads as a check, not a mutation, when input.action is read-only (#5170)', () => {
    // "Updated automations · DONE" when the assistant only listed automations
    // reads as a change the tech never asked for. A read-only `action` on the
    // call forces the `get` verb forms regardless of the leading verb.
    expect(aiToolLabel('manage_automations', 'completed', { action: 'list' })).toBe(
      'Checked automations',
    );
    expect(aiToolLabel('manage_automations', 'running', { action: 'list' })).toBe(
      'Checking automations',
    );
    for (const action of ['list', 'get', 'search', 'status', 'show', 'read', 'query', 'describe', 'check', 'preview', 'view']) {
      expect(aiToolLabel('manage_services', 'completed', { action })).toBe('Checked services');
    }
    // Case-insensitive.
    expect(aiToolLabel('manage_automations', 'completed', { action: 'LIST' })).toBe(
      'Checked automations',
    );
  });

  it('leaves the verb alone when input.action is a mutation or absent', () => {
    expect(aiToolLabel('manage_automations', 'completed', { action: 'create' })).toBe(
      'Updated automations',
    );
    expect(aiToolLabel('manage_automations', 'completed')).toBe('Updated automations');
    expect(aiToolLabel('manage_automations', 'completed', {})).toBe('Updated automations');
    expect(aiToolLabel('manage_automations', 'completed', { action: 42 })).toBe(
      'Updated automations',
    );
  });
});
