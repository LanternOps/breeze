import { describe, it, expect } from 'vitest';
import { registerTicketingTools } from './aiToolsTicketing';
import type { AiTool } from './aiTools';

describe('manage_tickets description property', () => {
  it('documents the time-entry work note and its customer visibility', () => {
    const tools = new Map<string, AiTool>();
    registerTicketingTools(tools);
    const props = tools.get('manage_tickets')!.definition.input_schema.properties as Record<string, { description?: string }>;
    const text = props.description?.description ?? '';
    for (const a of ['create', 'log_time_entry', 'start_timer', 'stop_timer', 'update_time_entry']) {
      expect(text).toContain(a);
    }
    expect(text).toContain('printed on the customer invoice');
  });
});
