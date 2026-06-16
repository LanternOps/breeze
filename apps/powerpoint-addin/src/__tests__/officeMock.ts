/**
 * Hand-rolled Office.js *PowerPoint* mock (jsdom). Installed fresh per test by
 * src/__tests__/setup.ts; tests seed and inspect presentation state via
 * getOfficeMock().
 *
 * PowerPoint's object model is a deck of slides, each holding shapes whose text
 * lives behind a textFrame — neither Excel's grid nor Word's linear body — so this
 * is a separate mock. It keeps the SAME faithfulness discipline as the Word/Excel
 * mocks so missing load()/sync() bugs fail tests:
 *  - property reads (slides.items, slide.title, shape.textFrame.hasText,
 *    textRange.text, getCount().value) THROW until a context.sync() has hydrated them
 *  - writes (font setters, slides.add, addTextBox, insertSlidesFromBase64) are queued
 *    and applied at sync()
 *  - PowerPoint.run() performs one trailing sync after the callback returns
 *
 * Critical addition over the Word mock: a per-test-togglable
 * Office.context.requirements.isSetSupported('PowerPointApi', v) backed by
 * state.supportedApiSets. PowerPoint's read/write surface only matured at 1.4, and
 * the add_slide tool has a native→OOXML fallback, so the A2 tools gate on this — the
 * mock must let a test flip a capability off and prove the {error}/fallback branch.
 *
 * Documented leniencies (do NOT rely on these in src/ production code):
 *  - Font property *writes* are accepted before sync (Office.js queues them too)
 *  - load() calls are recorded (state.loadCalls) but NOT enforced: a read is gated on
 *    sync() having hydrated it, not on a matching load() (same stance as the Excel/Word
 *    mocks — all current executors load() correctly).
 */
import { vi } from 'vitest';

/** Font patch recorded against a shape's text range at sync. */
export type FontPatch = {
  bold?: boolean;
  italic?: boolean;
  /** PowerPoint.ShapeFontUnderlineStyle string, e.g. 'Single' | 'None'. */
  underline?: string;
  color?: string;
  size?: number;
};

/** Seed-state for a single shape on a slide. */
export class MockShapeState {
  /** Whether this shape carries a text frame at all (e.g. a picture has none). */
  hasTextFrame: boolean;
  /** The shape's text (empty string ⇒ textFrame.hasText === false). */
  text: string;
  /** Font patches applied to this shape this test, in apply order. */
  fontPatches: FontPatch[] = [];
  constructor(text = '', hasTextFrame = true) {
    this.text = text;
    this.hasTextFrame = hasTextFrame;
  }
}

let slideIdCounter = 0;

/** Seed-state for a single slide. shapes[0] is treated as the title placeholder. */
export class MockSlideState {
  shapes: MockShapeState[];
  /** Stable per-slide id (PowerPoint.Slide.id) — lets the selected-slide index be
   *  resolved by matching getSelectedSlides() against the deck, as the real API does. */
  readonly id: string = `slide-${(slideIdCounter += 1)}`;
  /** How the slide was created — lets a test assert the add_slide fallback path. */
  createdVia: 'seed' | 'native' | 'ooxml' = 'seed';
  constructor(shapes: MockShapeState[] = []) {
    this.shapes = shapes;
  }
  /** First shape's text, treated as the slide title (empty if no shapes). */
  get title(): string {
    return this.shapes[0]?.text ?? '';
  }
}

/** A layout under a slide master (resolved by add_slide by name or first). */
export type MockLayout = { id: string; name: string };

export class MockPresentationState {
  /** Presentation file name (readable after presentation.load('title')). */
  presentationTitle = 'Presentation1';
  /** Every slide in deck order. */
  slides: MockSlideState[] = [new MockSlideState([new MockShapeState('Slide 1')])];
  /** Indices (into slides) that are currently selected. */
  selectedSlideIndices: number[] = [0];
  /** Shapes currently selected (a flat set, independent of slide selection). */
  selectedShapes: MockShapeState[] = [];
  /** Single slide master with its layouts (native add_slide resolves layoutId here). */
  slideMasterId = 'master-1';
  layouts: MockLayout[] = [
    { id: 'layout-blank', name: 'Blank' },
    { id: 'layout-title', name: 'Title Slide' },
  ];
  /** PowerPointApi requirement-set versions reported as supported (feature detect). */
  supportedApiSets = new Set(['1.1', '1.2', '1.3', '1.4']);
  loadCalls: Array<{ target: string; props: unknown }> = [];
  syncCount = 0;
  selectionHandlers: Array<() => void> = [];

  /** Seam helper: replace the whole deck from a compact shape-text spec. */
  setSlides(slides: Array<string[] | MockSlideState>): void {
    this.slides = slides.map((s) =>
      s instanceof MockSlideState ? s : new MockSlideState(s.map((t) => new MockShapeState(t))),
    );
    this.selectedSlideIndices = this.selectedSlideIndices.filter((i) => i < this.slides.length);
  }

  /** Seam helper: select slides by index and fire selection-changed handlers. */
  selectSlides(indices: number[]): void {
    this.selectedSlideIndices = indices.filter((i) => i >= 0 && i < this.slides.length);
    this.fireSelectionChanged();
  }

  /** Seam helper: select a set of shapes and fire selection-changed handlers. */
  selectShapes(shapes: MockShapeState[]): void {
    this.selectedShapes = shapes;
    this.fireSelectionChanged();
  }

  fireSelectionChanged(): void {
    for (const handler of [...this.selectionHandlers]) handler();
  }
}

type Syncable = { _sync(): void };

class MockPowerPointContext {
  private tracked: Syncable[] = [];
  readonly presentation: MockPresentation;

  constructor(readonly state: MockPresentationState) {
    this.presentation = new MockPresentation(this);
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

/** A load-gated scalar (e.g. a getCount() result's `.value`). */
class MockScalar<T> implements Syncable {
  private hydrated = false;
  constructor(
    private ctx: MockPowerPointContext,
    private read: () => T,
  ) {
    ctx.track(this);
  }
  get value(): T {
    if (!this.hydrated)
      throw new Error('PropertyNotLoaded: scalar .value read before context.sync()');
    return this.read();
  }
  _sync(): void {
    this.hydrated = true;
  }
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

/** shape.textFrame.textRange — load-gated `.text`, settable `.font`. */
class MockTextRange implements Syncable {
  private hydrated = false;
  private _text = '';
  private fontPatch: FontPatch = {};
  readonly font: ReturnType<typeof makeFont>;

  constructor(
    private ctx: MockPowerPointContext,
    private shape: MockShapeState,
  ) {
    this.font = makeFont(this.fontPatch);
    ctx.track(this);
  }

  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: 'textRange', props });
    return this;
  }

  get text(): string {
    if (!this.hydrated)
      throw new Error('PropertyNotLoaded: TextRange.text read before context.sync()');
    return this._text;
  }

  _sync(): void {
    if (Object.keys(this.fontPatch).length > 0) {
      this.shape.fontPatches.push({ ...this.fontPatch });
      for (const k of Object.keys(this.fontPatch))
        delete (this.fontPatch as Record<string, unknown>)[k];
    }
    this._text = this.shape.text;
    this.hydrated = true;
  }
}

/** shape.textFrame — load-gated `.hasText`, lazy `.textRange`. */
class MockTextFrame implements Syncable {
  private hydrated = false;
  constructor(
    private ctx: MockPowerPointContext,
    private shape: MockShapeState,
  ) {
    ctx.track(this);
  }

  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: 'textFrame', props });
    return this;
  }

  get hasText(): boolean {
    if (!this.hydrated)
      throw new Error('PropertyNotLoaded: TextFrame.hasText read before context.sync()');
    // A shape without a text frame, or with empty text, reports no text.
    return this.shape.hasTextFrame && this.shape.text.length > 0;
  }

  get textRange(): MockTextRange {
    return new MockTextRange(this.ctx, this.shape);
  }

  _sync(): void {
    this.hydrated = true;
  }
}

class MockShape {
  readonly textFrame: MockTextFrame;
  constructor(
    private ctx: MockPowerPointContext,
    readonly state: MockShapeState,
  ) {
    this.textFrame = new MockTextFrame(ctx, state);
  }
  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: 'shape', props });
    return this;
  }
}

/** slide.shapes — load-gated `.items`; addTextBox queues a new shape at sync. */
class MockShapeCollection implements Syncable {
  private _items: MockShape[] | null = null;
  private pendingTextBoxes: MockShapeState[] = [];

  constructor(
    private ctx: MockPowerPointContext,
    private slide: MockSlideState,
  ) {
    ctx.track(this);
  }

  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: 'slide.shapes', props });
    return this;
  }

  getCount(): MockScalar<number> {
    return new MockScalar(this.ctx, () => this.slide.shapes.length);
  }

  get items(): MockShape[] {
    if (!this._items)
      throw new Error('PropertyNotLoaded: ShapeCollection.items read before context.sync()');
    return this._items;
  }

  addTextBox(text: string, _options?: unknown): MockShape {
    const shapeState = new MockShapeState(text);
    this.pendingTextBoxes.push(shapeState);
    return new MockShape(this.ctx, shapeState);
  }

  _sync(): void {
    for (const ts of this.pendingTextBoxes) this.slide.shapes.push(ts);
    this.pendingTextBoxes = [];
    this._items = this.slide.shapes.map((s) => new MockShape(this.ctx, s));
  }
}

class MockSlide {
  readonly shapes: MockShapeCollection;
  // Slides are populated *by* their collection's _sync (load('items/id') hydrates
  // each item's scalar in the same round-trip, as real Office.js does) — so a
  // slide is born hydrated, like the Word mock's MockParagraph. The read gate that
  // matters (an un-synced collection) lives on the collection's `.items` getter.
  private hydrated = true;
  constructor(
    private ctx: MockPowerPointContext,
    readonly state: MockSlideState,
  ) {
    this.shapes = new MockShapeCollection(ctx, state);
    ctx.track(this);
  }
  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: 'slide', props });
    return this;
  }
  get id(): string {
    if (!this.hydrated) throw new Error('PropertyNotLoaded: Slide.id read before context.sync()');
    return this.state.id;
  }
  get title(): string {
    if (!this.hydrated)
      throw new Error('PropertyNotLoaded: Slide.title read before context.sync()');
    return this.state.title;
  }
  _sync(): void {
    this.hydrated = true;
  }
}

/** presentation.slides — load-gated `.items`; `.add()` queues a native slide. */
class MockSlideCollection implements Syncable {
  private _items: MockSlide[] | null = null;
  private pendingNative: MockSlideState[] = [];

  constructor(
    private ctx: MockPowerPointContext,
    private source: () => MockSlideState[],
    private target: string,
  ) {
    ctx.track(this);
  }

  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: `${this.target}.slides`, props });
    return this;
  }

  getCount(): MockScalar<number> {
    return new MockScalar(this.ctx, () => this.source().length);
  }

  get items(): MockSlide[] {
    if (!this._items)
      throw new Error('PropertyNotLoaded: SlideCollection.items read before context.sync()');
    return this._items;
  }

  /** Native add. Real API only exists at PowerPointApi 1.4+; mirror that so the
   *  add_slide native→OOXML fallback is provable by toggling supportedApiSets. */
  add(_options?: { slideMasterId?: string; layoutId?: string }): void {
    if (!this.ctx.state.supportedApiSets.has('1.4'))
      throw new Error('NotSupported: SlideCollection.add requires PowerPointApi 1.4');
    const slide = new MockSlideState([new MockShapeState('')]);
    slide.createdVia = 'native';
    this.pendingNative.push(slide);
  }

  _sync(): void {
    for (const s of this.pendingNative) this.source().push(s);
    this.pendingNative = [];
    this._items = this.source().map((s) => new MockSlide(this.ctx, s));
  }
}

/** A single slide layout exposed under a slide master. */
class MockLayoutObj {
  constructor(readonly state: MockLayout) {}
  load(_props: unknown): this {
    return this;
  }
  get id(): string {
    return this.state.id;
  }
  get name(): string {
    return this.state.name;
  }
}

class MockLayoutCollection implements Syncable {
  private _items: MockLayoutObj[] | null = null;
  constructor(
    private ctx: MockPowerPointContext,
    private layouts: () => MockLayout[],
  ) {
    ctx.track(this);
  }
  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: 'layouts', props });
    return this;
  }
  get items(): MockLayoutObj[] {
    if (!this._items)
      throw new Error('PropertyNotLoaded: LayoutCollection.items read before context.sync()');
    return this._items;
  }
  _sync(): void {
    this._items = this.layouts().map((l) => new MockLayoutObj(l));
  }
}

class MockSlideMaster {
  readonly layouts: MockLayoutCollection;
  private hydrated = false;
  constructor(
    private ctx: MockPowerPointContext,
    private state: MockPresentationState,
  ) {
    this.layouts = new MockLayoutCollection(ctx, () => state.layouts);
    ctx.track(this);
  }
  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: 'slideMaster', props });
    return this;
  }
  get id(): string {
    if (!this.hydrated)
      throw new Error('PropertyNotLoaded: SlideMaster.id read before context.sync()');
    return this.state.slideMasterId;
  }
  _sync(): void {
    this.hydrated = true;
  }
}

class MockSlideMasterCollection implements Syncable {
  private _items: MockSlideMaster[] | null = null;
  constructor(
    private ctx: MockPowerPointContext,
    private state: MockPresentationState,
  ) {
    ctx.track(this);
  }
  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: 'slideMasters', props });
    return this;
  }
  get items(): MockSlideMaster[] {
    if (!this._items)
      throw new Error('PropertyNotLoaded: SlideMasterCollection.items read before context.sync()');
    return this._items;
  }
  _sync(): void {
    // A single master in this mock.
    this._items = [new MockSlideMaster(this.ctx, this.state)];
  }
}

class MockPresentation implements Syncable {
  readonly slides: MockSlideCollection;
  readonly slideMasters: MockSlideMasterCollection;
  private titleHydrated = false;

  constructor(private ctx: MockPowerPointContext) {
    this.slides = new MockSlideCollection(ctx, () => ctx.state.slides, 'presentation');
    this.slideMasters = new MockSlideMasterCollection(ctx, ctx.state);
    ctx.track(this);
  }

  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: 'presentation', props });
    return this;
  }

  get title(): string {
    if (!this.titleHydrated)
      throw new Error('PropertyNotLoaded: Presentation.title read before context.sync()');
    return this.ctx.state.presentationTitle;
  }

  getSelectedSlides(): MockSlideCollection {
    return new MockSlideCollection(
      this.ctx,
      () => this.ctx.state.selectedSlideIndices.map((i) => this.ctx.state.slides[i]),
      'selectedSlides',
    );
  }

  getSelectedShapes(): MockSelectedShapeCollection {
    return new MockSelectedShapeCollection(this.ctx);
  }

  /** OOXML fallback path for add_slide — appends one slide flagged as 'ooxml'. */
  insertSlidesFromBase64(_base64: string, _options?: unknown): void {
    const slide = new MockSlideState([new MockShapeState('')]);
    slide.createdVia = 'ooxml';
    this.ctx.state.slides.push(slide);
  }

  _sync(): void {
    this.titleHydrated = true;
  }
}

/** presentation.getSelectedShapes() — load-gated `.items` of the selected shapes. */
class MockSelectedShapeCollection implements Syncable {
  private _items: MockShape[] | null = null;
  constructor(private ctx: MockPowerPointContext) {
    ctx.track(this);
  }
  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: 'selectedShapes', props });
    return this;
  }
  getCount(): MockScalar<number> {
    return new MockScalar(this.ctx, () => this.ctx.state.selectedShapes.length);
  }
  get items(): MockShape[] {
    if (!this._items)
      throw new Error(
        'PropertyNotLoaded: SelectedShapeCollection.items read before context.sync()',
      );
    return this._items;
  }
  _sync(): void {
    this._items = this.ctx.state.selectedShapes.map((s) => new MockShape(this.ctx, s));
  }
}

let current: MockPresentationState | null = null;

export function installOfficeMock(): MockPresentationState {
  const state = new MockPresentationState();
  current = state;
  const g = globalThis as Record<string, unknown>;
  g.PowerPoint = {
    run: async <T>(callback: (context: unknown) => Promise<T>): Promise<T> => {
      const context = new MockPowerPointContext(state);
      const result = await callback(context);
      await context.sync(); // PowerPoint.run always performs a trailing sync
      return result;
    },
    ShapeFontUnderlineStyle: { none: 'None', single: 'Single' },
  };
  g.Office = {
    onReady: (cb?: (info: { host: string; platform: string }) => void) => {
      const info = { host: 'PowerPoint', platform: 'Mock' };
      cb?.(info);
      return Promise.resolve(info);
    },
    EventType: { DocumentSelectionChanged: 'documentSelectionChanged' },
    context: {
      requirements: {
        // Per-test togglable via state.supportedApiSets — flip a version off to
        // prove the 1.4 capability gates and the add_slide native→OOXML fallback.
        isSetSupported: (name: string, minVersion?: string): boolean => {
          if (name !== 'PowerPointApi') return false;
          if (!minVersion) return true;
          return state.supportedApiSets.has(minVersion);
        },
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

export function getOfficeMock(): MockPresentationState {
  if (!current)
    throw new Error('installOfficeMock() has not run — is src/__tests__/setup.ts configured?');
  return current;
}
