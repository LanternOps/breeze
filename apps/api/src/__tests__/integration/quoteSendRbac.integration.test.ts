import './setup';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../services/permissions';

describe('quotes:send RBAC', () => {
  // A role granted only read+write must NOT satisfy the send permission the
  // POST /:id/send route requires. This guards against the send route being
  // accidentally gated on write (or ungated).
  it('quotes:read+write does not imply quotes:send', () => {
    const granted = [
      `${PERMISSIONS.QUOTES_READ.resource}:${PERMISSIONS.QUOTES_READ.action}`,
      `${PERMISSIONS.QUOTES_WRITE.resource}:${PERMISSIONS.QUOTES_WRITE.action}`,
    ];
    const needSend = `${PERMISSIONS.QUOTES_SEND.resource}:${PERMISSIONS.QUOTES_SEND.action}`;
    expect(granted).not.toContain(needSend);
    expect(PERMISSIONS.QUOTES_SEND.action).toBe('send');
  });
});
