import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { hasMailbox18, parseReferences, readEmailIdentity } from './emailIdentity';

describe('parseReferences', () => {
  it('extracts every <...> token from a single-line header', () => {
    expect(parseReferences('<a@x> <b@x>')).toEqual(['<a@x>', '<b@x>']);
  });

  it('unfolds a CRLF + leading-whitespace continuation before extracting', () => {
    expect(parseReferences('<a@x>\r\n <b@x>')).toEqual(['<a@x>', '<b@x>']);
  });

  it('unfolds a bare-LF + tab continuation too', () => {
    expect(parseReferences('<a@x>\n\t<b@x>')).toEqual(['<a@x>', '<b@x>']);
  });

  it('returns [] when there are no message-id tokens', () => {
    expect(parseReferences('')).toEqual([]);
  });
});

describe('hasMailbox18', () => {
  it('reflects the mock host requirement set (default 1.8, supported)', () => {
    expect(hasMailbox18()).toBe(true);
  });

  it('is false when the mock host reports an older Mailbox version', () => {
    getOfficeMock().supportedMailboxVersion = '1.7';
    expect(hasMailbox18()).toBe(false);
  });
});

describe('readEmailIdentity — read mode, Mailbox 1.8', () => {
  it('reads internetMessageId + parses References/In-Reply-To from the raw header block', async () => {
    getOfficeMock().setItem(
      {
        subject: 'Re: Printer down',
        from: { displayName: 'Alice', emailAddress: 'alice@example.com' },
        conversationId: 'conv-1',
        internetMessageId: '<msg-3@example.com>',
        rawHeaders:
          'Subject: Re: Printer down\r\n' +
          'References: <msg-1@example.com>\r\n <msg-2@example.com>\r\n' +
          'In-Reply-To: <msg-2@example.com>\r\n',
      },
      'read',
    );

    const identity = await readEmailIdentity();

    expect(identity.mode).toBe('read');
    expect(identity.headerCapable).toBe(true);
    expect(identity.internetMessageId).toBe('<msg-3@example.com>');
    expect(identity.references).toEqual(['<msg-1@example.com>', '<msg-2@example.com>']);
    expect(identity.inReplyTo).toBe('<msg-2@example.com>');
    expect(identity.conversationId).toBe('conv-1');
    expect(identity.subject).toBe('Re: Printer down');
    expect(identity.from).toEqual({ email: 'alice@example.com', name: 'Alice' });
  });

  it('handles a folded multi-line References header spanning more than two lines', async () => {
    getOfficeMock().setItem(
      {
        internetMessageId: '<msg-4@example.com>',
        rawHeaders:
          'References: <msg-1@example.com>\r\n <msg-2@example.com>\r\n <msg-3@example.com>\r\n',
      },
      'read',
    );

    const identity = await readEmailIdentity();

    expect(identity.references).toEqual(['<msg-1@example.com>', '<msg-2@example.com>', '<msg-3@example.com>']);
  });

  it('returns null/[] identifiers when no References/In-Reply-To headers are present', async () => {
    getOfficeMock().setItem({ internetMessageId: '<msg-solo@example.com>', rawHeaders: '' }, 'read');

    const identity = await readEmailIdentity();

    expect(identity.headerCapable).toBe(true);
    expect(identity.internetMessageId).toBe('<msg-solo@example.com>');
    expect(identity.references).toEqual([]);
    expect(identity.inReplyTo).toBeNull();
  });
});

describe('readEmailIdentity — below Mailbox 1.8 (degrade path)', () => {
  it('reports headerCapable false with null/[] identifiers, but still populates subject/from', async () => {
    getOfficeMock().supportedMailboxVersion = '1.7';
    getOfficeMock().setItem(
      {
        subject: 'Legacy client',
        from: { displayName: 'Bob', emailAddress: 'bob@example.com' },
        internetMessageId: '<would-be-hidden@example.com>',
        rawHeaders: 'References: <would-be-hidden@example.com>\r\n',
      },
      'read',
    );

    const identity = await readEmailIdentity();

    expect(identity.mode).toBe('read');
    expect(identity.headerCapable).toBe(false);
    expect(identity.internetMessageId).toBeNull();
    expect(identity.references).toEqual([]);
    expect(identity.inReplyTo).toBeNull();
    expect(identity.subject).toBe('Legacy client');
    expect(identity.from).toEqual({ email: 'bob@example.com', name: 'Bob' });
  });
});

describe('readEmailIdentity — compose mode', () => {
  it('reports mode compose without treating the item as headerCapable', async () => {
    getOfficeMock().setItem({ subject: 'New message' }, 'compose');

    const identity = await readEmailIdentity();

    expect(identity.mode).toBe('compose');
    expect(identity.headerCapable).toBe(false);
    expect(identity.internetMessageId).toBeNull();
    expect(identity.references).toEqual([]);
  });
});

describe('readEmailIdentity — no item open (pinned pane transition)', () => {
  it('resolves to mode none without throwing', async () => {
    const g = globalThis as { Office?: { context?: { mailbox?: unknown } } };
    const originalMailbox = g.Office?.context?.mailbox;
    if (g.Office?.context) g.Office.context.mailbox = undefined;

    await expect(readEmailIdentity()).resolves.toEqual({
      mode: 'none',
      subject: '',
      from: null,
      sender: null,
      conversationId: null,
      internetMessageId: null,
      references: [],
      inReplyTo: null,
      headerCapable: false,
      sharedMailbox: false,
    });

    if (g.Office?.context) g.Office.context.mailbox = originalMailbox;
  });
});

describe('readEmailIdentity — send-on-behalf-of', () => {
  it('surfaces from and sender distinctly when they differ', async () => {
    getOfficeMock().setItem(
      {
        from: { displayName: 'Team Alias', emailAddress: 'team@example.com' },
        sender: { displayName: 'Alice', emailAddress: 'alice@example.com' },
      },
      'read',
    );

    const identity = await readEmailIdentity();

    expect(identity.from).toEqual({ email: 'team@example.com', name: 'Team Alias' });
    expect(identity.sender).toEqual({ email: 'alice@example.com', name: 'Alice' });
  });

  it('falls back sender to from when the host has no distinct sender', async () => {
    getOfficeMock().setItem(
      { from: { displayName: 'Alice', emailAddress: 'alice@example.com' } },
      'read',
    );

    const identity = await readEmailIdentity();

    expect(identity.sender).toEqual(identity.from);
  });
});

describe('readEmailIdentity — shared mailbox detection', () => {
  it('flags sharedMailbox true when getSharedPropertiesAsync is present', async () => {
    getOfficeMock().setItem({ sharedMailbox: true }, 'read');

    const identity = await readEmailIdentity();

    expect(identity.sharedMailbox).toBe(true);
  });

  it('flags sharedMailbox false when getSharedPropertiesAsync is absent', async () => {
    getOfficeMock().setItem({}, 'read');

    const identity = await readEmailIdentity();

    expect(identity.sharedMailbox).toBe(false);
  });
});
