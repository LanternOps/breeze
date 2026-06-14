import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));

import {
  ticketThreadAnchor,
  commentMessageId,
  buildThreadingHeaders,
  partnerInboundAddress,
} from './outboundThreading';

describe('outbound threading helpers', () => {
  it('ticketThreadAnchor is deterministic from ticketId', () => {
    expect(ticketThreadAnchor('t-1')).toBe('<ticket-t-1@tickets.example.com>');
  });

  it('commentMessageId is deterministic from ticketId + commentId', () => {
    expect(commentMessageId('t-1', 'c-9')).toBe('<ticket-t-1-c-9@tickets.example.com>');
  });

  it('partnerInboundAddress derives {slug}@TICKETS_INBOUND_DOMAIN by default', () => {
    expect(partnerInboundAddress('acme', undefined)).toBe('acme@tickets.example.com');
  });

  it('partnerInboundAddress honors the self-hosted override (spec §2)', () => {
    // partner.settings.ticketing.inbound.address overrides the derived default.
    expect(partnerInboundAddress('acme', 'support@helpdesk.theirmsp.com'))
      .toBe('support@helpdesk.theirmsp.com');
  });

  it('partnerInboundAddress ignores a blank override and falls back to the derived default', () => {
    expect(partnerInboundAddress('acme', '   ')).toBe('acme@tickets.example.com');
  });

  it('buildThreadingHeaders sets Message-ID, In-Reply-To, References to the anchor', () => {
    const h = buildThreadingHeaders({ ticketId: 't-1', commentId: 'c-9' });
    expect(h['Message-ID']).toBe('<ticket-t-1-c-9@tickets.example.com>');
    expect(h['In-Reply-To']).toBe('<ticket-t-1@tickets.example.com>');
    expect(h['References']).toBe('<ticket-t-1@tickets.example.com>');
  });

  it('buildThreadingHeaders without commentId (autoresponse) uses the anchor as Message-ID', () => {
    const h = buildThreadingHeaders({ ticketId: 't-1' });
    expect(h['Message-ID']).toBe('<ticket-t-1@tickets.example.com>');
    expect(h['In-Reply-To']).toBeUndefined();
  });

  it('returns empty headers / null address when TICKETS_INBOUND_DOMAIN is unset', async () => {
    vi.resetModules();
    vi.doMock('../../config/validate', () => ({ getConfig: () => ({}) }));
    const mod = await import('./outboundThreading');
    expect(mod.buildThreadingHeaders({ ticketId: 't-1', commentId: 'c-9' })).toEqual({});
    expect(mod.partnerInboundAddress('acme', undefined)).toBeNull();
    // …but a configured override still wins even with no platform domain (self-hosted):
    expect(mod.partnerInboundAddress('acme', 'support@helpdesk.theirmsp.com'))
      .toBe('support@helpdesk.theirmsp.com');
  });

  it('degrades to no-headers / null address when getConfig() THROWS (uninitialized config on the worker path)', async () => {
    // On the notify-worker path getConfig() throws if config was never validated;
    // domain() must catch and degrade, never propagate the throw.
    vi.resetModules();
    vi.doMock('../../config/validate', () => ({
      getConfig: () => { throw new Error('config not initialized'); }
    }));
    const mod = await import('./outboundThreading');
    expect(() => mod.buildThreadingHeaders({ ticketId: 't-1', commentId: 'c-9' })).not.toThrow();
    expect(mod.buildThreadingHeaders({ ticketId: 't-1', commentId: 'c-9' })).toEqual({});
    expect(mod.ticketThreadAnchor('t-1')).toBeNull();
    expect(mod.partnerInboundAddress('acme', undefined)).toBeNull();
    // A configured override still wins (it never reads the domain).
    expect(mod.partnerInboundAddress('acme', 'support@helpdesk.theirmsp.com'))
      .toBe('support@helpdesk.theirmsp.com');
  });
});
