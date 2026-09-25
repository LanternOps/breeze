import { describe, it, expect, vi } from 'vitest';

// One fake DWD session shared by both reads, so a test can assert the cursor probe
// and the identity read go through the SAME session (Codex finding: no two-token race).
const sessionMock = vi.hoisted(() => ({ getProfile: vi.fn(), identity: vi.fn(), getInboundMailboxSession: vi.fn() }));
vi.mock('../googleClient', async (importActual) => {
  const actual = await importActual<typeof import('../googleClient')>();
  return {
    ...actual,
    getInboundMailboxSession: sessionMock.getInboundMailboxSession,
  };
});

import { classifyGmailError, resolveReferencedTextBodies, probeMailboxForConnect, MailboxProbeError, listInboxMessageIdsSince, getFullMessage } from './googleMailboxClient';
import { MAX_BODY_B64_CHARS, MAX_BODY_BYTES } from './normalizeGmailMessage';

/** Shape a gaxios-like error: a status plus an optional Google reason code. */
function gErr(status: number, reason?: string): unknown {
  return {
    status,
    response: {
      status,
      data: reason ? { error: { errors: [{ reason }] } } : undefined,
    },
  };
}

describe('classifyGmailError', () => {
  it('treats 429 as a rate limit (retry, not reauth)', () => {
    expect(classifyGmailError(gErr(429))).toBe('rate_limit');
  });

  it('treats a 403 rateLimitExceeded/userRateLimitExceeded as a rate limit, NOT reauth', () => {
    // The critical distinction Codex flagged: Graph maps every 403 to reauth,
    // but Gmail 403 is frequently a transient quota error.
    expect(classifyGmailError(gErr(403, 'rateLimitExceeded'))).toBe('rate_limit');
    expect(classifyGmailError(gErr(403, 'userRateLimitExceeded'))).toBe('rate_limit');
    expect(classifyGmailError(gErr(403, 'quotaExceeded'))).toBe('rate_limit');
  });

  it('treats a 403 dailyLimitExceeded / sharingRateLimitExceeded as a rate limit, NOT reauth', () => {
    // Project daily-quota exhaustion. If misclassified as reauth it sets
    // status='reauth_required' and permanently drops the mailbox from polling
    // (which selects only 'connected' rows) even after the quota resets.
    expect(classifyGmailError(gErr(403, 'dailyLimitExceeded'))).toBe('rate_limit');
    expect(classifyGmailError(gErr(403, 'sharingRateLimitExceeded'))).toBe('rate_limit');
  });

  it('treats a genuine 401/403 credential failure as reauth', () => {
    expect(classifyGmailError(gErr(401))).toBe('reauth');
    expect(classifyGmailError(gErr(403, 'forbidden'))).toBe('reauth');
  });

  it('treats 5xx as transient', () => {
    expect(classifyGmailError(gErr(500))).toBe('transient');
    expect(classifyGmailError(gErr(503))).toBe('transient');
  });

  it('treats a real 4xx API error (with a status) as fatal', () => {
    // A 400 has an HTTP status: the request itself is malformed, retrying will
    // not help, so it is correctly terminal.
    expect(classifyGmailError(gErr(400))).toBe('fatal');
  });

  it('treats a STATUS-LESS transport error as transient, NOT fatal (retryable)', () => {
    // Regression: a network blip (ECONNRESET, DNS, timeout) has no HTTP status.
    // Classifying it fatal set the mailbox status='error', and the sweep only
    // polls 'connected' rows, so one transient failure would permanently remove
    // the mailbox from polling. These must stay retryable.
    expect(classifyGmailError(new Error('boom'))).toBe('transient');
    expect(classifyGmailError(undefined)).toBe('transient');
    expect(classifyGmailError({ code: 'ECONNRESET' })).toBe('transient');
  });
});

describe('listInboxMessageIdsSince (expiry-recovery query boundary)', () => {
  it('queries one second BEFORE the floor so the floor second is included even if Gmail after: is exclusive', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const gmail = {
      users: { messages: { list: async (params: Record<string, unknown>) => {
        calls.push(params);
        return { data: { messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: undefined } };
      } } },
    } as never;

    const ids = await listInboxMessageIdsSince(gmail, 1_700_000_100);

    expect(ids).toEqual(['a', 'b']);
    // floor 1700000100 -> query after:1700000099 (widened by 1s). A strict-exclusive
    // `after:` would then still return anything at second 1700000100, which is the
    // floor second an in-flight message could occupy.
    expect(calls[0]!.q).toBe('after:1700000099');
  });

  it('never queries a negative epoch (clamps at 0)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const gmail = {
      users: { messages: { list: async (params: Record<string, unknown>) => {
        calls.push(params);
        return { data: { messages: [], nextPageToken: undefined } };
      } } },
    } as never;

    await listInboxMessageIdsSince(gmail, 0);

    expect(calls[0]!.q).toBe('after:0');
  });
});

describe('resolveReferencedTextBodies', () => {
  function b64url(s: string): string {
    return Buffer.from(s, 'utf8').toString('base64url');
  }

  it('inlines a referenced (attachmentId) text/html body the normalizer would otherwise drop', async () => {
    const message = {
      payload: {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { size: 5, data: b64url('short') } },
          { mimeType: 'text/html', body: { attachmentId: 'att-big', size: 200000 } },
        ],
      },
    };
    const calls: string[] = [];
    const gmail = {
      users: {
        messages: {
          attachments: {
            get: async (args: { id: string }) => {
              calls.push(args.id);
              return { data: { data: b64url('<p>the full large body</p>') } };
            },
          },
        },
      },
    };
    await resolveReferencedTextBodies(gmail as never, 'mid-1', message as never);
    expect(calls).toEqual(['att-big']);
    // The referenced html body is now inline as `data`, so the pure normalizer sees it.
    expect(message.payload.parts[1]!.body!.data).toBe(b64url('<p>the full large body</p>'));
    // The already-inline text part is untouched (no needless fetch).
    expect(message.payload.parts[0]!.body!.data).toBe(b64url('short'));
  });

  it('does not fetch bodies for real file attachments (they carry a filename)', async () => {
    const message = {
      payload: {
        parts: [
          { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'att-pdf', size: 9000 } },
        ],
      },
    };
    let fetched = false;
    const gmail = { users: { messages: { attachments: { get: async () => { fetched = true; return { data: {} }; } } } } };
    await resolveReferencedTextBodies(gmail as never, 'mid-2', message as never);
    expect(fetched).toBe(false);
  });

  it('does not fetch an UNNAMED Content-Disposition: attachment text part as a body', async () => {
    // RFC 2183: an `attachment` part need not carry a filename. It must not be
    // mistaken for a referenced text body to inline.
    const message = {
      payload: {
        parts: [
          {
            mimeType: 'text/plain',
            headers: [{ name: 'Content-Disposition', value: 'attachment' }],
            body: { attachmentId: 'att-unnamed', size: 300000 },
          },
        ],
      },
    };
    let fetched = false;
    const gmail = { users: { messages: { attachments: { get: async () => { fetched = true; return { data: {} }; } } } } };
    await resolveReferencedTextBodies(gmail as never, 'mid-3', message as never);
    expect(fetched).toBe(false);
  });

  it('does NOT fetch a referenced text body whose declared size exceeds the cap (bounds peak allocation)', async () => {
    // attachments.get returns the whole part in one response, so the only place to
    // bound peak memory is before the call, via the declared size.
    const message = {
      payload: { parts: [{ mimeType: 'text/plain', body: { attachmentId: 'att-huge', size: MAX_BODY_BYTES + 1 } }] },
    };
    let fetched = false;
    const gmail = { users: { messages: { attachments: { get: async () => { fetched = true; return { data: {} }; } } } } };
    await resolveReferencedTextBodies(gmail as never, 'mid-4', message as never);
    expect(fetched).toBe(false);
  });

  it('still slices the RETAINED copy when a within-cap part returns an understated (oversized) body', async () => {
    // Declared size within the cap, so we fetch; a lying/understated size that
    // returns a longer string is the residual API limitation — the retained copy
    // is clamped so downstream decode stays bounded.
    const message = {
      payload: { parts: [{ mimeType: 'text/plain', body: { attachmentId: 'att-lie', size: 10 } as { attachmentId: string; size: number; data?: string } }] },
    };
    const huge = 'A'.repeat(MAX_BODY_B64_CHARS * 2);
    const gmail = { users: { messages: { attachments: { get: async () => ({ data: { data: huge } }) } } } };
    await resolveReferencedTextBodies(gmail as never, 'mid-5', message as never);
    expect(message.payload.parts[0]!.body.data!.length).toBe(MAX_BODY_B64_CHARS);
  });

  it('skips a referenced part whose attachment fetch 404s WITHOUT discarding the whole message', async () => {
    // A 404 on a referenced text PART must not bubble up to getFullMessage, which
    // treats a 404 as "message deleted" and skips it (advancing the cursor).
    type Body = { attachmentId: string; size: number; data?: string };
    const message = {
      payload: {
        parts: [
          { mimeType: 'text/plain', body: { attachmentId: 'gone', size: 100 } as Body },
          { mimeType: 'text/html', body: { attachmentId: 'ok', size: 100 } as Body },
        ],
      },
    };
    const gmail = {
      users: { messages: { attachments: { get: async ({ id }: { id: string }) => {
        if (id === 'gone') throw gErr(404);
        return { data: { data: b64url('<p>ok</p>') } };
      } } } },
    };
    await resolveReferencedTextBodies(gmail as never, 'mid-6', message as never);
    expect(message.payload.parts[0]!.body.data).toBeUndefined(); // 404 part left un-inlined
    expect(message.payload.parts[1]!.body.data).toBe(b64url('<p>ok</p>')); // sibling still inlined
  });

  it('rethrows a NON-404 attachment error so the sweep does not advance the cursor', async () => {
    const message = {
      payload: { parts: [{ mimeType: 'text/plain', body: { attachmentId: 'x', size: 100 } }] },
    };
    const gmail = { users: { messages: { attachments: { get: async () => { throw gErr(500); } } } } };
    await expect(resolveReferencedTextBodies(gmail as never, 'mid-7', message as never)).rejects.toBeTruthy();
  });
});

describe('probeMailboxForConnect (single-session cursor + identity)', () => {
  const wireSession = (over: { profile?: unknown; identity?: unknown } = {}) => {
    sessionMock.getProfile.mockReset();
    sessionMock.identity.mockReset();
    if (over.profile instanceof Error) sessionMock.getProfile.mockRejectedValue(over.profile);
    else sessionMock.getProfile.mockResolvedValue(over.profile ?? { data: { historyId: '900' } });
    if (over.identity instanceof Error) sessionMock.identity.mockRejectedValue(over.identity);
    else sessionMock.identity.mockResolvedValue(over.identity ?? { sub: 'sub-xyz', email: 'help@client.example' });
    const session = { gmail: { users: { getProfile: sessionMock.getProfile } }, identity: sessionMock.identity };
    sessionMock.getInboundMailboxSession.mockReturnValue(session);
    return session;
  };

  it('reads the cursor and the immutable sub through ONE session', async () => {
    wireSession();
    const res = await probeMailboxForConnect('key', 'help@client.example');
    expect(res).toEqual({ historyId: '900', sub: 'sub-xyz', email: 'help@client.example' });
    // Exactly one session minted; both reads went through it.
    expect(sessionMock.getInboundMailboxSession).toHaveBeenCalledTimes(1);
    expect(sessionMock.getProfile).toHaveBeenCalledTimes(1);
    expect(sessionMock.identity).toHaveBeenCalledTimes(1);
  });

  it('throws MailboxProbeError kind=read when the profile read fails', async () => {
    wireSession({ profile: new Error('403') });
    await expect(probeMailboxForConnect('key', 'help@client.example')).rejects.toMatchObject({ kind: 'read' });
    expect(sessionMock.identity).not.toHaveBeenCalled(); // no identity read after a failed cursor read
  });

  it('throws MailboxProbeError kind=read when the profile has no historyId', async () => {
    wireSession({ profile: { data: {} } });
    await expect(probeMailboxForConnect('key', 'help@client.example')).rejects.toBeInstanceOf(MailboxProbeError);
    await expect(probeMailboxForConnect('key', 'help@client.example')).rejects.toMatchObject({ kind: 'read' });
  });

  it('throws MailboxProbeError kind=identity when the identity read fails', async () => {
    wireSession({ identity: new Error('missing openid scope') });
    await expect(probeMailboxForConnect('key', 'help@client.example')).rejects.toMatchObject({ kind: 'identity' });
  });

  it('tolerates an alias (returned email differs from the impersonated address) and still returns the sub', async () => {
    wireSession({ identity: { sub: 'sub-primary', email: 'owner@client.example' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await probeMailboxForConnect('key', 'alias@client.example');
    expect(res.sub).toBe('sub-primary'); // sub is authoritative; mismatch is a diagnostic warning
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});


describe('getFullMessage (404 = deleted-race skip; other errors abort)', () => {
  it('returns null when messages.get rejects with a real gaxios 404 (message deleted between list and fetch)', async () => {
    const gmail = {
      users: {
        messages: {
          // gaxios error shape: status on response.status.
          get: vi.fn().mockRejectedValue(Object.assign(new Error('Not Found'), { response: { status: 404 } })),
        },
      },
    } as unknown as Parameters<typeof getFullMessage>[0];
    await expect(getFullMessage(gmail, 'gone-id')).resolves.toBeNull();
  });

  it('RETHROWS a non-404 error (e.g. 500) so the sweep aborts the page instead of skipping unread mail', async () => {
    const gmail = {
      users: {
        messages: {
          get: vi.fn().mockRejectedValue(Object.assign(new Error('backend error'), { response: { status: 500 } })),
        },
      },
    } as unknown as Parameters<typeof getFullMessage>[0];
    await expect(getFullMessage(gmail, 'boom-id')).rejects.toThrow('backend error');
  });
});
