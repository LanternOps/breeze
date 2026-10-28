import { describe, expect, it } from 'vitest';
import {
  CONCERN_KIND_TO_ENTITY_KIND,
  WISP_THREAD_LINK_LIMIT,
  WISP_THREAD_AUTO_LINK_LIMIT,
  WISP_AUTO_LINKS_PER_TURN,
  WISP_SEED_AUTO_LINK_MAX_LINES,
} from './wisp';

describe('working-set links', () => {
  it('maps org concerns to organization and drops integration/incident', () => {
    expect(CONCERN_KIND_TO_ENTITY_KIND).toEqual({
      org: 'organization',
      ticket: 'ticket',
      device: 'device',
      alert: 'alert',
      run: 'run',
      task: 'task',
      quote: 'quote',
      invoice: 'invoice',
      contract: 'contract',
      site: 'site',
    });
    expect(CONCERN_KIND_TO_ENTITY_KIND).not.toHaveProperty('integration');
    expect(CONCERN_KIND_TO_ENTITY_KIND).not.toHaveProperty('incident');
  });

  it('defines the working-set limits', () => {
    expect(WISP_THREAD_LINK_LIMIT).toBe(50);
    expect(WISP_THREAD_AUTO_LINK_LIMIT).toBe(20);
    expect(WISP_AUTO_LINKS_PER_TURN).toBe(5);
    expect(WISP_SEED_AUTO_LINK_MAX_LINES).toBe(15);
  });
});
