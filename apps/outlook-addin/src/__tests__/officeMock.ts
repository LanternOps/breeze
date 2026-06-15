/**
 * Hand-rolled Office.js *mailbox* mock (jsdom). Installed fresh per test by
 * src/__tests__/setup.ts; tests seed and inspect mailbox state via
 * getOfficeMock().
 *
 * Outlook is the mail-model outlier: there is no `Word.run`/`Excel.run` and no
 * document object model. The surface is `Office.context.mailbox.item` in one of
 * two modes — `read` (an existing message is open) or `compose` (the user is
 * drafting). The Excel grid mock and the Word linear-text mock are 0% reusable
 * here, so this is a separate mock.
 *
 * Faithfulness discipline (so adapter/tool bugs fail tests):
 *  - `mailbox.item` is exposed as a GETTER over the current item, so an item
 *    switch (switchItem()) replaces the object the host hands back. An adapter
 *    that caches `item` once on mount would read the STALE item — the
 *    item-changed re-read test relies on this.
 *  - `item.body.getAsync` / `setAsync` are async (callback with an AsyncResult);
 *    `setAsync` is only available in compose mode (matching the real host — in
 *    read mode the body is immutable and the draft path is displayReplyForm).
 *  - `item.displayReplyForm` / `displayReplyAllForm` are synchronous and exist
 *    only in read mode (you reply TO an open message; you can't "reply" while
 *    already composing). Tools must self-guard which path exists.
 *  - `mailbox.addHandlerAsync(Office.EventType.ItemChanged, cb)` only retains a
 *    handler for ItemChanged — a wrong EventType wiring registers nothing and
 *    its callback never fires (mirrors real Office).
 *
 * Documented leniencies (do NOT rely on these in src/ production code):
 *  - `from`/`to`/`cc` are plain EmailAddressDetails objects/arrays available
 *    synchronously in both modes (the real compose-mode recipients are async
 *    via getAsync); the mock keeps them sync because the read-surface tools only
 *    read them in read mode.
 *  - coercionType passed to body.getAsync is recorded but not used to transform
 *    the body text (the mock stores one plain-text body).
 */
import { vi } from 'vitest';

/** Outlook's EmailAddressDetails shape (subset the tools read). */
export type EmailAddress = { displayName: string; emailAddress: string };

/** A reply request captured by displayReplyForm/displayReplyAllForm (read mode). */
export type DisplayedReply = { all: boolean; htmlBody: string };

/** Seed shape for setItem()/switchItem(). All fields optional; sensible defaults. */
export type ItemSeed = {
  subject?: string;
  body?: string;
  from?: EmailAddress;
  to?: EmailAddress[];
  cc?: EmailAddress[];
  dateTimeCreated?: Date;
};

const DEFAULT_FROM: EmailAddress = { displayName: 'Sender', emailAddress: 'sender@example.com' };

type AsyncResult<T> = {
  status: 'succeeded' | 'failed';
  value: T;
  error?: { name: string; message: string; code: number };
};

function succeeded<T>(value: T): AsyncResult<T> {
  return { status: 'succeeded', value };
}

function failed<T>(value: T, message: string): AsyncResult<T> {
  return { status: 'failed', value, error: { name: 'AsyncError', message, code: 9001 } };
}

/**
 * One mailbox item. The set of *methods* present depends on `mode`:
 *  - read:    body.getAsync, displayReplyForm, displayReplyAllForm (NO body.setAsync)
 *  - compose: body.getAsync + body.setAsync (NO displayReply* forms)
 * This asymmetry is the whole point of the draft_reply mode-guard, so the mock
 * enforces it rather than exposing every method in both modes.
 */
export class MockMailboxItem {
  subject: string;
  bodyText: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  dateTimeCreated: Date;
  readonly body: {
    getAsync: (coercionType: string, cb: (r: AsyncResult<string>) => void) => void;
    setAsync?: (
      data: string,
      options: unknown,
      cb?: (r: AsyncResult<void>) => void,
    ) => void;
  };
  displayReplyForm?: (formData: string | { htmlBody?: string }) => void;
  displayReplyAllForm?: (formData: string | { htmlBody?: string }) => void;

  constructor(
    private state: MockMailboxState,
    readonly mode: 'read' | 'compose',
    seed: ItemSeed,
  ) {
    this.subject = seed.subject ?? '';
    this.bodyText = seed.body ?? '';
    this.from = seed.from ?? DEFAULT_FROM;
    this.to = seed.to ?? [];
    this.cc = seed.cc ?? [];
    this.dateTimeCreated = seed.dateTimeCreated ?? new Date('2026-06-14T00:00:00.000Z');

    const self = this;
    this.body = {
      getAsync(coercionType: string, cb: (r: AsyncResult<string>) => void): void {
        state.bodyGetCalls.push({ coercionType });
        // Faithfulness: the real host can hand back a failed AsyncResult (offline,
        // permissions, large-body limits). state.failBodyGet flips the next read
        // to 'failed' so the readBodyText reject path is testable.
        if (state.failBodyGet) {
          cb(failed('', 'getAsync failed (simulated host error)'));
        } else {
          cb(succeeded(self.bodyText));
        }
      },
    };

    if (mode === 'compose') {
      // Compose mode: the body is writable; the reply forms do not exist.
      this.body.setAsync = (
        data: string,
        _options: unknown,
        cb?: (r: AsyncResult<void>) => void,
      ): void => {
        // state.failBodySet flips the write to 'failed' (without mutating the
        // body) so the draft_reply false-success guard is testable.
        if (state.failBodySet) {
          cb?.(failed(undefined, 'setAsync failed (simulated host error)'));
          return;
        }
        self.bodyText = data;
        state.composeSetBodies.push(data);
        cb?.(succeeded(undefined));
      };
    } else {
      // Read mode: the body is immutable; you draft via reply forms.
      this.displayReplyForm = (formData: string | { htmlBody?: string }): void => {
        state.displayedReplies.push({ all: false, htmlBody: normalizeReply(formData) });
      };
      this.displayReplyAllForm = (formData: string | { htmlBody?: string }): void => {
        state.displayedReplies.push({ all: true, htmlBody: normalizeReply(formData) });
      };
    }
  }
}

function normalizeReply(formData: string | { htmlBody?: string }): string {
  return typeof formData === 'string' ? formData : (formData.htmlBody ?? '');
}

export class MockMailboxState {
  /** The currently-open item, replaced by switchItem(). */
  item: MockMailboxItem;
  /** Active mode for newly-created items (read | compose). */
  mode: 'read' | 'compose' = 'read';
  /** ItemChanged handlers registered via addHandlerAsync. */
  itemChangedHandlers: Array<() => void> = [];
  /** Every body.getAsync call this test (seam inspection). */
  bodyGetCalls: Array<{ coercionType: string }> = [];
  /** Bodies written via compose-mode body.setAsync, in order (seam inspection). */
  composeSetBodies: string[] = [];
  /** Reply forms displayed via read-mode displayReply(All)Form (seam inspection). */
  displayedReplies: DisplayedReply[] = [];
  /** When true, body.getAsync returns a failed AsyncResult (host-error sim). */
  failBodyGet = false;
  /** When true, compose body.setAsync returns a failed AsyncResult (host-error sim). */
  failBodySet = false;

  constructor() {
    this.item = new MockMailboxItem(this, this.mode, {});
  }

  /** Seam helper: replace the current item in place (no ItemChanged fired). */
  setItem(seed: ItemSeed, mode?: 'read' | 'compose'): MockMailboxItem {
    if (mode) this.mode = mode;
    this.item = new MockMailboxItem(this, this.mode, seed);
    return this.item;
  }

  /** Seam helper: switch to a new item AND fire ItemChanged (a pinned-pane item
   *  switch). Proves the adapter re-reads `mailbox.item` rather than caching it. */
  switchItem(seed: ItemSeed, mode?: 'read' | 'compose'): MockMailboxItem {
    const item = this.setItem(seed, mode);
    this.fireItemChanged();
    return item;
  }

  fireItemChanged(): void {
    for (const handler of [...this.itemChangedHandlers]) handler();
  }
}

let current: MockMailboxState | null = null;

export function installOfficeMock(): MockMailboxState {
  const state = new MockMailboxState();
  current = state;
  const g = globalThis as Record<string, unknown>;

  const mailbox = {
    // `item` is a getter so the host always hands back the CURRENT item — an
    // adapter that re-reads mailbox.item picks up a switchItem(), one that
    // caches it on mount gets the stale object.
    get item(): MockMailboxItem {
      return state.item;
    },
    addHandlerAsync: (
      type: string,
      handler: () => void,
      _options?: unknown,
      done?: (result: { status: string }) => void,
    ) => {
      // Real Office only invokes a handler for the event it was registered
      // under, so only retain ItemChanged handlers — a wrong EventType wiring
      // then registers nothing and its callback never fires.
      if (type === 'olkItemSelectedChanged') {
        state.itemChangedHandlers.push(handler);
      }
      const cb = typeof _options === 'function' ? (_options as typeof done) : done;
      cb?.({ status: 'succeeded' });
    },
    removeHandlerAsync: (
      _type: string,
      options?: { handler?: () => void } | (() => void),
      done?: (result: { status: string }) => void,
    ) => {
      const handler = typeof options === 'function' ? undefined : options?.handler;
      if (handler) {
        const i = state.itemChangedHandlers.indexOf(handler);
        if (i >= 0) state.itemChangedHandlers.splice(i, 1);
      } else {
        state.itemChangedHandlers = [];
      }
      const cb = typeof options === 'function' ? options : done;
      cb?.({ status: 'succeeded' });
    },
  };

  g.Office = {
    onReady: (cb?: (info: { host: string; platform: string }) => void) => {
      const info = { host: 'Outlook', platform: 'Mock' };
      cb?.(info);
      return Promise.resolve(info);
    },
    HostType: { Outlook: 'Outlook' },
    AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
    CoercionType: { Text: 'text', Html: 'html' },
    // Outlook's item-switch event id (the value the real host registers under).
    EventType: { ItemChanged: 'olkItemSelectedChanged' },
    context: {
      requirements: {
        isSetSupported: (name: string, _minVersion?: string): boolean => name === 'Mailbox',
      },
      mailbox,
    },
  };
  g.OfficeRuntime = { auth: { getAccessToken: vi.fn(async () => 'mock-entra-access-token') } };
  return state;
}

export function getOfficeMock(): MockMailboxState {
  if (!current)
    throw new Error('installOfficeMock() has not run — is src/__tests__/setup.ts configured?');
  return current;
}
