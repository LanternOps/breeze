import { M365_COMMS_MAX_RETRIEVED_BODY_BYTES } from '@breeze/shared/m365';
import { describe, expect, it, vi } from 'vitest';
import { executeGraphCommsInlineAction, type GraphCommsActionContext } from './commsMailActions';
import type { OpaqueAccessToken } from './delegatedClient';
import { GraphClientError, type MicrosoftGraphClient } from './graphClient';

const ACCESS_TOKEN = 'opaque-access-token' as OpaqueAccessToken;
const NOW = new Date('2026-07-29T12:00:00.000Z');

function ctx(graphClient: Partial<MicrosoftGraphClient>): GraphCommsActionContext {
  return {
    accessToken: ACCESS_TOKEN,
    graphClient: graphClient as MicrosoftGraphClient,
    now: () => NOW,
  };
}

describe('m365.comms.mail.list', () => {
  it('lists a folder with select, top, and orderby — and projects every item', async () => {
    const readCollection = vi.fn().mockResolvedValue({
      items: [{
        id: 'm1', subject: 'Hello', bodyPreview: 'pre', internetMessageHeaders: [{ leak: true }],
        body: { content: 'FULL BODY MUST NOT ESCAPE A LIST' },
      }],
      truncated: false,
    });

    const result = await executeGraphCommsInlineAction(
      { type: 'm365.comms.mail.list', folder: 'inbox' },
      ctx({ readCollection }),
    );

    expect(readCollection).toHaveBeenCalledWith({
      accessToken: ACCESS_TOKEN,
      path: '/me/mailFolders/inbox/messages',
      query: {
        $select: expect.stringContaining('id,subject,from'),
        $top: '25',
        $orderby: 'receivedDateTime desc',
      },
      maxItems: 25,
      maxPages: 1,
    });
    expect(result).toEqual({
      success: true,
      kind: 'collection',
      items: [{ id: 'm1', subject: 'Hello', bodyPreview: 'pre' }],
      truncated: false,
    });
  });

  it('translates sinceHours into a receivedDateTime filter from the injected clock', async () => {
    const readCollection = vi.fn().mockResolvedValue({ items: [], truncated: false });

    await executeGraphCommsInlineAction(
      { type: 'm365.comms.mail.list', folder: 'archive', sinceHours: 24, pageSize: 5 },
      ctx({ readCollection }),
    );

    const query = readCollection.mock.calls[0]![0].query as Record<string, string>;
    expect(query.$filter).toBe('receivedDateTime ge 2026-07-28T12:00:00.000Z');
    expect(query.$top).toBe('5');
    expect(readCollection.mock.calls[0]![0].path).toBe('/me/mailFolders/archive/messages');
  });

  it('uses quoted $search without $orderby or $filter', async () => {
    const readCollection = vi.fn().mockResolvedValue({ items: [], truncated: false });

    await executeGraphCommsInlineAction(
      { type: 'm365.comms.mail.list', folder: 'inbox', search: 'invoice' },
      ctx({ readCollection }),
    );

    const query = readCollection.mock.calls[0]![0].query as Record<string, string>;
    expect(query.$search).toBe('"invoice"');
    expect(query).not.toHaveProperty('$orderby');
    expect(query).not.toHaveProperty('$filter');
  });
});

describe('m365.comms.mail.get', () => {
  it('expands attachments to the metadata allowlist and projects the message', async () => {
    const readResource = vi.fn().mockResolvedValue({
      id: 'm1',
      subject: 'S',
      body: { contentType: 'text', content: 'body-text' },
      attachments: [{ id: 'a1', name: 'file.pdf', contentType: 'application/pdf', size: 10, isInline: false, contentBytes: 'U0VDUkVU' }],
      internetMessageHeaders: [{ leak: true }],
    });

    const result = await executeGraphCommsInlineAction(
      { type: 'm365.comms.mail.get', messageId: 'm1' },
      ctx({ readResource }),
    );

    expect(readResource).toHaveBeenCalledWith({
      accessToken: ACCESS_TOKEN,
      path: '/me/messages/m1',
      select: expect.not.arrayContaining(['attachments']),
      expand: 'attachments($select=id,name,contentType,size,isInline)',
    });
    expect(result).toMatchObject({
      success: true,
      kind: 'resource',
      truncated: false,
      resource: {
        id: 'm1',
        subject: 'S',
        body: { contentType: 'text', content: 'body-text' },
        // Attachment CONTENT is never returned — names and sizes only.
        attachments: [{ id: 'a1', name: 'file.pdf', contentType: 'application/pdf', size: 10, isInline: false }],
      },
    });
    const resource = (result as { resource: Record<string, unknown> }).resource;
    expect(resource).not.toHaveProperty('internetMessageHeaders');
    expect(JSON.stringify(resource)).not.toContain('U0VDUkVU');
  });

  it('caps body.content in UTF-8 bytes at a code-point boundary and flags truncation', async () => {
    // Astral characters are 4 UTF-8 bytes each; an even cap would land
    // mid-character if the cut were byte-oriented.
    const emoji = '\u{1F600}';
    const oversized = emoji.repeat(Math.ceil(M365_COMMS_MAX_RETRIEVED_BODY_BYTES / 4) + 10);
    const readResource = vi.fn().mockResolvedValue({
      id: 'm1',
      body: { contentType: 'html', content: oversized },
    });

    const result = await executeGraphCommsInlineAction(
      { type: 'm365.comms.mail.get', messageId: 'm1' },
      ctx({ readResource }),
    );

    expect(result.success).toBe(true);
    const resource = (result as { resource: Record<string, unknown>; truncated: boolean });
    expect(resource.truncated).toBe(true);
    const content = (resource.resource.body as { content: string; contentType: string }).content;
    const bytes = new TextEncoder().encode(content).byteLength;
    expect(bytes).toBeLessThanOrEqual(M365_COMMS_MAX_RETRIEVED_BODY_BYTES);
    // Cut at a code-point boundary: the string still ends with a whole emoji.
    expect(content.endsWith(emoji)).toBe(true);
    // contentType passes through as Graph returned it — not sanitized here.
    expect((resource.resource.body as { contentType: string }).contentType).toBe('html');
  });

  it('maps graph_not_found to message_not_found (comms taxonomy)', async () => {
    const readResource = vi.fn().mockRejectedValue(new GraphClientError('graph_not_found'));

    const result = await executeGraphCommsInlineAction(
      { type: 'm365.comms.mail.get', messageId: 'gone' },
      ctx({ readResource }),
    );

    expect(result).toEqual({ success: false, errorCode: 'message_not_found' });
  });
});

describe('m365.comms.mail.draft.create', () => {
  it('POSTs the draft and projects only id and webLink', async () => {
    const post = vi.fn().mockResolvedValue({
      status: 201,
      body: { id: 'draft-1', webLink: 'https://outlook.example/d1', subject: 'S', body: { content: 'leak' } },
    });

    const result = await executeGraphCommsInlineAction(
      {
        type: 'm365.comms.mail.draft.create',
        to: ['a@example.com'],
        cc: ['b@example.com'],
        subject: 'S',
        bodyText: 'B',
      },
      ctx({ post }),
    );

    expect(post).toHaveBeenCalledWith({
      accessToken: ACCESS_TOKEN,
      path: '/me/messages',
      body: {
        subject: 'S',
        body: { contentType: 'Text', content: 'B' },
        toRecipients: [{ emailAddress: { address: 'a@example.com' } }],
        ccRecipients: [{ emailAddress: { address: 'b@example.com' } }],
      },
    });
    expect(result).toEqual({
      success: true,
      kind: 'resource',
      resource: { id: 'draft-1', webLink: 'https://outlook.example/d1' },
    });
  });
});

describe('failure mapping', () => {
  it('keeps retryAfterSeconds on graph_throttled', async () => {
    const readCollection = vi.fn().mockRejectedValue(new GraphClientError('graph_throttled', 17));
    const result = await executeGraphCommsInlineAction(
      { type: 'm365.comms.mail.list', folder: 'inbox' },
      ctx({ readCollection }),
    );
    expect(result).toEqual({ success: false, errorCode: 'graph_throttled', retryAfterSeconds: 17 });
  });

  it('folds enum-external Graph codes into graph_response_invalid', async () => {
    const readCollection = vi.fn().mockRejectedValue(new GraphClientError('graph_provider_rejected'));
    const result = await executeGraphCommsInlineAction(
      { type: 'm365.comms.mail.list', folder: 'inbox' },
      ctx({ readCollection }),
    );
    expect(result).toEqual({ success: false, errorCode: 'graph_response_invalid' });
  });

  it('re-throws non-Graph errors (they surface as the app 500, never a fabricated failure)', async () => {
    const readCollection = vi.fn().mockRejectedValue(new TypeError('bug'));
    await expect(executeGraphCommsInlineAction(
      { type: 'm365.comms.mail.list', folder: 'inbox' },
      ctx({ readCollection }),
    )).rejects.toThrow('bug');
  });
});
