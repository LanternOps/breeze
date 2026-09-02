import { describe, it, expect } from 'vitest';
import { TICKET_ATTACHMENT_LIMITS } from './ticketAttachments';

describe('TICKET_ATTACHMENT_LIMITS', () => {
  it('pins the D5 limits shared by api, web and mobile', () => {
    expect(TICKET_ATTACHMENT_LIMITS.maxBytes).toBe(10 * 1024 * 1024);
    expect(TICKET_ATTACHMENT_LIMITS.maxPerComment).toBe(5);
    expect(TICKET_ATTACHMENT_LIMITS.maxPendingPerUser).toBe(20);
    expect([...TICKET_ATTACHMENT_LIMITS.allowedMimes]).toEqual([
      'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
    ]);
  });
});
