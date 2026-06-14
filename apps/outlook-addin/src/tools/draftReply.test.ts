import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { draftReply } from './draftReply';

describe('draft_reply — mode-dependent (mutating)', () => {
  it('read mode → opens a single reply form via displayReplyForm', async () => {
    const mock = getOfficeMock();
    mock.setItem({ subject: 'Original', body: 'Question?' }, 'read');
    const result = (await draftReply({ body: 'Here is my answer.' })) as { mode: string };
    expect(result.mode).toBe('read');
    expect(mock.displayedReplies).toEqual([{ all: false, htmlBody: 'Here is my answer.' }]);
    // Read mode never writes the open body.
    expect(mock.composeSetBodies).toEqual([]);
  });

  it('read mode + replyAll → opens a reply-all form', async () => {
    const mock = getOfficeMock();
    mock.setItem({ subject: 'Original', body: 'Question?' }, 'read');
    await draftReply({ body: 'Reply to everyone.', replyAll: true });
    expect(mock.displayedReplies).toEqual([{ all: true, htmlBody: 'Reply to everyone.' }]);
  });

  it('compose mode → writes the open draft body via body.setAsync', async () => {
    const mock = getOfficeMock();
    mock.setItem({ subject: 'Draft', body: '' }, 'compose');
    const result = (await draftReply({ body: 'My drafted reply.' })) as { mode: string };
    expect(result.mode).toBe('compose');
    expect(mock.composeSetBodies).toEqual(['My drafted reply.']);
    // Compose mode never opens a reply form (it doesn't exist on the item).
    expect(mock.displayedReplies).toEqual([]);
  });

  it('compose mode ignores replyAll (no reply form in compose)', async () => {
    const mock = getOfficeMock();
    mock.setItem({ subject: 'Draft', body: '' }, 'compose');
    await draftReply({ body: 'Drafted.', replyAll: true });
    expect(mock.composeSetBodies).toEqual(['Drafted.']);
    expect(mock.displayedReplies).toEqual([]);
  });

  it('compose mode rejects when setAsync fails (no false success)', async () => {
    const mock = getOfficeMock();
    mock.setItem({ subject: 'Draft', body: '' }, 'compose');
    mock.failBodySet = true;
    // setAsync failed → the body was never written, so the tool must reject
    // (chatController collapses this to { status:'error' }) rather than report
    // a false success.
    await expect(draftReply({ body: 'Never written.' })).rejects.toThrow(/setAsync failed/);
    expect(mock.composeSetBodies).toEqual([]);
  });

  it('returns a clear error when neither path is available', async () => {
    const mock = getOfficeMock();
    // Seed a read item, then strip both reply forms so neither path exists —
    // mutatingTools is a static Set, so the executor must self-guard.
    mock.setItem({ subject: 'Stuck', body: '' }, 'read');
    mock.item.displayReplyForm = undefined;
    mock.item.displayReplyAllForm = undefined;
    const result = (await draftReply({ body: 'No path.' })) as { error?: string };
    expect(typeof result.error).toBe('string');
    expect(result.error).toBeTruthy();
  });

  it('rejects an empty body', async () => {
    getOfficeMock().setItem({ subject: 'x', body: '' }, 'read');
    await expect(draftReply({ body: '' })).rejects.toThrow();
  });

  it('re-reads mailbox.item after an item switch (pinned-pane rebinding)', async () => {
    const mock = getOfficeMock();
    mock.setItem({ subject: 'First', body: '' }, 'read');
    // Switch to a COMPOSE item (fires ItemChanged); the executor must bind the
    // NEW item — proving it re-reads mailbox.item rather than caching it.
    mock.switchItem({ subject: 'Second', body: '' }, 'compose');
    const result = (await draftReply({ body: 'Bound to the new item.' })) as { mode: string };
    expect(result.mode).toBe('compose');
    expect(mock.composeSetBodies).toEqual(['Bound to the new item.']);
    expect(mock.displayedReplies).toEqual([]);
  });
});
