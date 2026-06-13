import { describe, expect, it, vi } from 'vitest';
import { ChatController, type ChatApi } from './chatController';
import { captureWorkbookContext } from './captureContext';
import { getOfficeMock } from '../__tests__/officeMock';
import { ApiError } from '../api/client';
import type { WorkbookContext } from '../api/types';

function stubApi(overrides: Partial<ChatApi> = {}): ChatApi {
  return {
    createSession: vi.fn(async () => 'sess-1'),
    sendMessage: vi.fn(async () => undefined),
    postToolResult: vi.fn(async () => undefined),
    streamEvents: vi.fn(() => ({ stop: vi.fn() })),
    getSession: vi.fn(async () => ({
      session: {
        id: 'sess-1',
        status: 'active',
        title: null,
        model: 'm',
        turnCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostCents: 0,
        createdAt: '',
        lastActivityAt: null,
      },
      messages: [],
    })),
    ...overrides,
  };
}

const SELECTION_CONTEXT: WorkbookContext = {
  kind: 'selection',
  address: 'Sheet1!B2:C3',
  sheetName: 'Sheet1',
  cells: [
    ['Region', 'Q1'],
    ['EMEA', 1200],
  ],
};

describe('ChatController — streaming', () => {
  it('accumulates message_delta text and finalizes one assistant message on turn_complete', () => {
    const controller = new ChatController({ api: stubApi() });
    controller.handleEvent({ type: 'message_delta', text: 'Hello ' });
    controller.handleEvent({ type: 'message_delta', text: 'world' });
    expect(controller.getState().streamingText).toBe('Hello world');
    controller.handleEvent({
      type: 'turn_complete',
      usage: { inputTokens: 10, outputTokens: 5, costCents: 1 },
    });
    const state = controller.getState();
    expect(state.streamingText).toBe('');
    expect(state.busy).toBe(false);
    expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 5, costCents: 1 });
    expect(state.thread.filter((m) => m.kind === 'assistant')).toEqual([
      expect.objectContaining({ kind: 'assistant', text: 'Hello world' }),
    ]);
  });

  it('session_error raises the error banner and clears busy', () => {
    const controller = new ChatController({ api: stubApi() });
    controller.handleEvent({ type: 'session_error', message: 'loop exploded' });
    expect(controller.getState().banner).toEqual({ kind: 'error', text: 'loop exploded' });
    expect(controller.getState().busy).toBe(false);
  });

  it('tool_completed appends an activity row with the redaction count and raises a block banner', () => {
    const controller = new ChatController({ api: stubApi() });
    controller.handleEvent({
      type: 'tool_completed',
      toolUseId: 'tu-1',
      toolName: 'read_range',
      status: 'success',
      redactions: [
        { rule: 'creditCard', count: 2, location: 'cell[0][0]' },
        { rule: 'ssn', count: 1, location: 'cell[1][1]' },
      ],
      blockReason: null,
    });
    expect(controller.getState().thread.at(-1)).toMatchObject({
      kind: 'tool',
      toolName: 'read_range',
      status: 'success',
      redactions: 3,
    });
    controller.handleEvent({
      type: 'tool_completed',
      toolUseId: 'tu-2',
      toolName: 'read_range',
      status: 'error',
      redactions: [],
      blockReason: 'dlp_blocked:creditCard',
    });
    expect(controller.getState().banner?.kind).toBe('blocked');
    expect(controller.getState().banner?.text).toContain('dlp_blocked:creditCard');
  });
});

describe('ChatController — send', () => {
  it('lazily creates the session, opens the stream once, and posts the pinned message body', async () => {
    const api = stubApi();
    const controller = new ChatController({ api, captureContext: async () => SELECTION_CONTEXT });
    await controller.send('What does column B total to?');
    await controller.send('And C?');
    expect(api.createSession).toHaveBeenCalledTimes(1); // the busy guard makes the 2nd send a no-op
    expect(api.streamEvents).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith('sess-1', {
      content: 'What does column B total to?',
      workbookContext: SELECTION_CONTEXT,
    });
    expect(controller.getState().thread[0]).toMatchObject({
      kind: 'user',
      text: 'What does column B total to?',
    });
    expect(controller.getState().busy).toBe(true);
  });

  it('surfaces budget rejections as a banner and clears busy', async () => {
    const api = stubApi({
      sendMessage: vi.fn(async () => {
        throw new ApiError(403, 'budget_exceeded');
      }),
    });
    const controller = new ChatController({ api, captureContext: async () => undefined });
    await controller.send('hi');
    expect(controller.getState().busy).toBe(false);
    expect(controller.getState().banner?.text).toContain('budget');
  });

  it('routes mutating tool_requests into the approval queue without posting', async () => {
    const api = stubApi();
    const controller = new ChatController({ api, captureContext: async () => undefined });
    await controller.send('write something'); // establishes sessionId
    controller.handleEvent({
      type: 'tool_request',
      toolUseId: 'tu-w1',
      toolName: 'write_range',
      input: { address: 'B2', values: [['x']] },
      mutating: true,
    });
    await vi.waitFor(() => expect(controller.approvals.getPending()).toHaveLength(1));
    expect(api.postToolResult).not.toHaveBeenCalled();
  });
});

describe('ChatController — draft & templates', () => {
  it('insertTemplate fills an empty draft and appends to a non-empty one', () => {
    const controller = new ChatController({ api: stubApi() });
    controller.insertTemplate('Summarize this sheet.');
    expect(controller.getState().draft).toBe('Summarize this sheet.');
    controller.insertTemplate('Then list outliers.');
    expect(controller.getState().draft).toBe('Summarize this sheet.\n\nThen list outliers.');
  });
});

describe('captureWorkbookContext', () => {
  it("'selection' captures the pinned payload shape from the live selection", async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'B2', [
      ['Region', 'Q1'],
      ['EMEA', 1200],
    ]);
    mock.select('Sheet1!B2:C3');
    await expect(captureWorkbookContext('selection')).resolves.toEqual(SELECTION_CONTEXT);
  });

  it("'sheet' captures the used range of the active sheet; 'none' sends kind only", async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [['x', 'y']]);
    await expect(captureWorkbookContext('sheet')).resolves.toEqual({
      kind: 'sheet',
      sheetName: 'Sheet1',
      address: 'Sheet1!A1:B1',
      cells: [['x', 'y']],
    });
    await expect(captureWorkbookContext('none')).resolves.toEqual({ kind: 'none' });
  });
});
