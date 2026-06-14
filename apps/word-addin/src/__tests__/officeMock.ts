/**
 * Hand-rolled Office.js *Word* mock (jsdom). Installed fresh per test by
 * src/__tests__/setup.ts; tests seed and inspect document state via
 * getOfficeMock().
 *
 * Word's object model is a linear text surface, not Excel's grid — so this is a
 * separate mock from the Excel one (the grid mock is 0% reusable). It keeps the
 * SAME faithfulness discipline so missing load()/sync() bugs fail tests:
 *  - property reads on a Range/Body (text, paragraphs items, search items) THROW
 *    until a context.sync() has hydrated them
 *  - writes (font setters, insertText, search-and-replace) are queued and applied
 *    at sync()
 *  - Word.run() performs one trailing sync after the callback returns
 * Documented leniencies (do NOT rely on these in src/ production code):
 *  - Font property *writes* are accepted before sync (Office.js queues them too)
 *  - InsertLocation strings are not validated by the mock (the executor validates)
 *  - load() calls are recorded (state.loadCalls) but NOT enforced: a read is gated
 *    on sync() having hydrated it, not on a matching load(). Real Office.js throws
 *    PropertyNotLoaded for a never-load()-ed property even after sync — so a missing
 *    .load() can pass here. (Same documented stance as the Excel mock; all current
 *    executors load() correctly. Harden both mocks together if this ever bites.)
 */
import { vi } from 'vitest';

/** A single paragraph's plain text. The body is the ordered list of these. */
type Paragraph = { text: string };

/** Font patch recorded against a range/body at sync (mirror of Range.font writes). */
export type FontPatch = {
  bold?: boolean;
  italic?: boolean;
  /** Word.UnderlineType string, e.g. 'Single' | 'None'. */
  underline?: string;
  color?: string;
  size?: number;
};

/** Where insertText drops its text relative to the target range. */
const INSERT_LOCATIONS = ['Replace', 'Start', 'End', 'Before', 'After'] as const;

function paragraphsOf(text: string): Paragraph[] {
  if (text === '') return [];
  return text.split('\n').map((t) => ({ text: t }));
}

export class MockDocumentState {
  /** Whole-document plain text (paragraphs joined by '\n'). */
  bodyText = '';
  /** File name, e.g. 'Proposal.docx' (readable after document load('name')). */
  documentName = 'Document1';
  /** Character offsets [start,end) of the current selection within bodyText. */
  selectionStart = 0;
  selectionEnd = 0;
  /** Every font patch applied this test, in apply order (seam inspection). */
  fontPatches: FontPatch[] = [];
  loadCalls: Array<{ target: string; props: unknown }> = [];
  syncCount = 0;
  selectionHandlers: Array<() => void> = [];

  /** Seam helper: set the whole document body. */
  setBody(text: string): void {
    this.bodyText = text;
    if (this.selectionStart > text.length) this.selectionStart = text.length;
    if (this.selectionEnd > text.length) this.selectionEnd = text.length;
  }

  /** Seam helper: move the selection to [start,end) and fire handlers. */
  select(start: number, end: number): void {
    this.selectionStart = Math.max(0, Math.min(start, this.bodyText.length));
    this.selectionEnd = Math.max(this.selectionStart, Math.min(end, this.bodyText.length));
    this.fireSelectionChanged();
  }

  /** Seam helper: the currently-selected substring. */
  selectedText(): string {
    return this.bodyText.slice(this.selectionStart, this.selectionEnd);
  }

  fireSelectionChanged(): void {
    for (const handler of [...this.selectionHandlers]) handler();
  }
}

type Syncable = { _sync(): void };

class MockWordContext {
  private tracked: Syncable[] = [];
  readonly document: MockDocument;

  constructor(readonly state: MockDocumentState) {
    this.document = new MockDocument(this);
  }

  track<T extends Syncable>(obj: T): T {
    this.tracked.push(obj);
    return obj;
  }

  sync = async (): Promise<void> => {
    this.state.syncCount += 1;
    for (const obj of [...this.tracked]) obj._sync();
  };
}

/** Settable font proxy — records bold/italic/underline/color/size onto a patch. */
function makeFont(patch: FontPatch): {
  bold: boolean;
  italic: boolean;
  underline: string;
  color: string;
  size: number;
} {
  const font = {} as {
    bold: boolean;
    italic: boolean;
    underline: string;
    color: string;
    size: number;
  };
  Object.defineProperty(font, 'bold', { set: (v: boolean) => (patch.bold = v) });
  Object.defineProperty(font, 'italic', { set: (v: boolean) => (patch.italic = v) });
  Object.defineProperty(font, 'underline', { set: (v: string) => (patch.underline = v) });
  Object.defineProperty(font, 'color', { set: (v: string) => (patch.color = v) });
  Object.defineProperty(font, 'size', { set: (v: number) => (patch.size = v) });
  return font;
}

/** A paragraph collection that hydrates `.items` (each with load-gated `.text`) at sync. */
class MockParagraphCollection implements Syncable {
  private _items: MockParagraph[] | null = null;

  constructor(
    private ctx: MockWordContext,
    private textOf: () => string,
    private target: string,
  ) {
    ctx.track(this);
  }

  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: `${this.target}.paragraphs`, props });
    return this;
  }

  get items(): MockParagraph[] {
    if (!this._items)
      throw new Error('PropertyNotLoaded: ParagraphCollection.items read before context.sync()');
    return this._items;
  }

  _sync(): void {
    this._items = paragraphsOf(this.textOf()).map((p) => new MockParagraph(p.text));
  }
}

class MockParagraph {
  private hydrated = true;
  constructor(private _text: string) {}
  load(_props: unknown): this {
    return this;
  }
  get text(): string {
    if (!this.hydrated)
      throw new Error('PropertyNotLoaded: Paragraph.text read before context.sync()');
    return this._text;
  }
}

/** A search-results collection: load-gated `.items` of replaceable matches. */
class MockSearchCollection implements Syncable {
  private _items: MockSearchMatch[] | null = null;
  private matches: MockSearchMatch[];

  constructor(
    private ctx: MockWordContext,
    query: string,
    opts: { matchCase?: boolean; matchWholeWord?: boolean } | undefined,
  ) {
    this.matches = MockSearchCollection.find(ctx.state, query, opts);
    ctx.track(this);
  }

  private static find(
    state: MockDocumentState,
    query: string,
    opts: { matchCase?: boolean; matchWholeWord?: boolean } | undefined,
  ): MockSearchMatch[] {
    if (query === '') return [];
    const flags = opts?.matchCase ? 'g' : 'gi';
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = opts?.matchWholeWord ? `\\b${escaped}\\b` : escaped;
    const re = new RegExp(pattern, flags);
    const out: MockSearchMatch[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(state.bodyText)) !== null) {
      out.push(new MockSearchMatch(m.index, m.index + m[0].length));
      if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width loops
    }
    return out;
  }

  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: 'search', props });
    return this;
  }

  get items(): MockSearchMatch[] {
    if (!this._items)
      throw new Error('PropertyNotLoaded: SearchCollection.items read before context.sync()');
    return this._items;
  }

  _sync(): void {
    this._items = this.matches;
    // Apply pending replacements right-to-left so earlier match offsets — captured
    // against the pre-edit body at search time — stay valid as we splice.
    const pending = this.matches
      .filter((m) => m.pendingReplace !== null)
      .sort((a, b) => b.start - a.start);
    for (const m of pending) {
      const body = this.ctx.state.bodyText;
      this.ctx.state.bodyText = body.slice(0, m.start) + m.pendingReplace!.text + body.slice(m.end);
      m.pendingReplace = null;
    }
  }
}

/** One search hit; insertText('replace') records a span replacement applied by
 *  the owning collection at sync (so multi-match offsets shift consistently). */
class MockSearchMatch {
  pendingReplace: { text: string } | null = null;
  constructor(
    readonly start: number,
    readonly end: number,
  ) {}

  insertText(text: string, _location: string): void {
    this.pendingReplace = { text };
  }
}

/** Shared text-range behavior for both getSelection() and body. */
class MockRange implements Syncable {
  private hydrated = false;
  private _text = '';
  private pendingInsert: { text: string; location: string } | null = null;
  private fontPatch: FontPatch = {};
  readonly font: ReturnType<typeof makeFont>;

  constructor(
    private ctx: MockWordContext,
    /** 'selection' reads the selected span; 'body' reads the whole document. */
    private kind: 'selection' | 'body',
  ) {
    this.font = makeFont(this.fontPatch);
    ctx.track(this);
  }

  private currentText(): string {
    const s = this.ctx.state;
    return this.kind === 'body' ? s.bodyText : s.selectedText();
  }

  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: this.kind, props });
    return this;
  }

  get text(): string {
    if (!this.hydrated)
      throw new Error(`PropertyNotLoaded: ${this.kind}.text read before context.sync()`);
    return this._text;
  }

  get paragraphs(): MockParagraphCollection {
    return new MockParagraphCollection(this.ctx, () => this.currentText(), this.kind);
  }

  insertText(text: string, location: string): MockRange {
    this.pendingInsert = { text, location };
    return this;
  }

  search(
    query: string,
    opts?: { matchCase?: boolean; matchWholeWord?: boolean },
  ): MockSearchCollection {
    return new MockSearchCollection(this.ctx, query, opts);
  }

  _sync(): void {
    const s = this.ctx.state;
    if (this.pendingInsert) {
      const { text, location } = this.pendingInsert;
      if (this.kind === 'selection') {
        const { selectionStart: a, selectionEnd: b } = s;
        switch (location) {
          case 'Replace':
            s.bodyText = s.bodyText.slice(0, a) + text + s.bodyText.slice(b);
            break;
          case 'Start':
          case 'Before':
            s.bodyText = s.bodyText.slice(0, a) + text + s.bodyText.slice(a);
            break;
          case 'End':
          case 'After':
            s.bodyText = s.bodyText.slice(0, b) + text + s.bodyText.slice(b);
            break;
          default:
            s.bodyText = s.bodyText.slice(0, a) + text + s.bodyText.slice(b);
        }
      } else {
        switch (location) {
          case 'Replace':
            s.bodyText = text;
            break;
          case 'Start':
          case 'Before':
            s.bodyText = text + s.bodyText;
            break;
          default:
            s.bodyText = s.bodyText + text;
        }
      }
      this.pendingInsert = null;
    }
    if (Object.keys(this.fontPatch).length > 0) {
      s.fontPatches.push({ ...this.fontPatch });
      for (const k of Object.keys(this.fontPatch)) delete (this.fontPatch as Record<string, unknown>)[k];
    }
    this._text = this.currentText();
    this.hydrated = true;
  }
}

class MockBody extends MockRange {
  constructor(ctx: MockWordContext) {
    super(ctx, 'body');
  }
}

class MockDocument implements Syncable {
  readonly body: MockBody;
  private nameHydrated = false;

  constructor(private ctx: MockWordContext) {
    this.body = new MockBody(ctx);
    ctx.track(this);
  }

  getSelection(): MockRange {
    return new MockRange(this.ctx, 'selection');
  }

  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: 'document', props });
    return this;
  }

  get name(): string {
    if (!this.nameHydrated)
      throw new Error('PropertyNotLoaded: Document.name read before context.sync()');
    return this.ctx.state.documentName;
  }

  _sync(): void {
    this.nameHydrated = true;
  }
}

let current: MockDocumentState | null = null;

export function installOfficeMock(): MockDocumentState {
  const state = new MockDocumentState();
  current = state;
  const g = globalThis as Record<string, unknown>;
  g.Word = {
    run: async <T>(callback: (context: unknown) => Promise<T>): Promise<T> => {
      const context = new MockWordContext(state);
      const result = await callback(context);
      await context.sync(); // Word.run always performs a trailing sync
      return result;
    },
    InsertLocation: {
      replace: 'Replace',
      start: 'Start',
      end: 'End',
      before: 'Before',
      after: 'After',
    },
    UnderlineType: { none: 'None', single: 'Single' },
    SearchOptions: class {},
  };
  g.Office = {
    onReady: (cb?: (info: { host: string; platform: string }) => void) => {
      const info = { host: 'Word', platform: 'Mock' };
      cb?.(info);
      return Promise.resolve(info);
    },
    EventType: { DocumentSelectionChanged: 'documentSelectionChanged' },
    context: {
      requirements: {
        isSetSupported: (name: string, _minVersion?: string): boolean => name === 'WordApi',
      },
      document: {
        addHandlerAsync: (
          type: string,
          handler: () => void,
          done?: (result: { status: string }) => void,
        ) => {
          // Real Office only invokes a handler for the event it was registered
          // under, so only retain DocumentSelectionChanged handlers — a wrong
          // EventType wiring then registers nothing and its callback never fires.
          if (type === 'documentSelectionChanged') {
            state.selectionHandlers.push(handler);
          }
          done?.({ status: 'succeeded' });
        },
        removeHandlerAsync: (
          _type: string,
          options?: { handler?: () => void } | (() => void),
          done?: (result: { status: string }) => void,
        ) => {
          const handler = typeof options === 'function' ? undefined : options?.handler;
          if (handler) {
            const i = state.selectionHandlers.indexOf(handler);
            if (i >= 0) state.selectionHandlers.splice(i, 1);
          } else {
            state.selectionHandlers = [];
          }
          const cb = typeof options === 'function' ? options : done;
          cb?.({ status: 'succeeded' });
        },
      },
    },
  };
  g.OfficeRuntime = { auth: { getAccessToken: vi.fn(async () => 'mock-entra-access-token') } };
  return state;
}

export function getOfficeMock(): MockDocumentState {
  if (!current)
    throw new Error('installOfficeMock() has not run — is src/__tests__/setup.ts configured?');
  return current;
}
