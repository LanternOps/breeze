import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RichTextEditor from './RichTextEditor';

// TipTap/ProseMirror wire up clipboard + drag handlers when the EditorView is
// constructed. jsdom ships neither constructor, so provide minimal no-op
// polyfills here (test-file scoped — keep the blast radius local per brief).
class FakeDataTransfer {
  items = [] as unknown[];
  files = [] as unknown[];
  getData() {
    return '';
  }
  setData() {}
}
if (typeof (globalThis as { ClipboardEvent?: unknown }).ClipboardEvent === 'undefined') {
  class ClipboardEventPolyfill extends Event {
    clipboardData = new FakeDataTransfer();
    constructor(type: string, init?: EventInit) {
      super(type, init);
    }
  }
  (globalThis as { ClipboardEvent?: unknown }).ClipboardEvent = ClipboardEventPolyfill;
}
if (typeof (globalThis as { DragEvent?: unknown }).DragEvent === 'undefined') {
  class DragEventPolyfill extends Event {
    dataTransfer = new FakeDataTransfer();
    constructor(type: string, init?: EventInit) {
      super(type, init);
    }
  }
  (globalThis as { DragEvent?: unknown }).DragEvent = DragEventPolyfill;
}

// ProseMirror computes caret coordinates (scrollToSelection) after every
// command via getClientRects(); jsdom implements neither getClientRects nor
// getBoundingClientRect on Range/Text, so stub empty rects (test-file scoped).
const emptyRect = () =>
  ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }) as DOMRect;
const emptyRectList = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
for (const proto of [Range.prototype, Text.prototype, Element.prototype]) {
  (proto as unknown as { getClientRects: () => DOMRectList }).getClientRects = emptyRectList;
  (proto as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = emptyRect;
}

const TOOLBAR_TESTIDS = [
  'rte-bold',
  'rte-italic',
  'rte-underline',
  'rte-h3',
  'rte-h4',
  'rte-bullet-list',
  'rte-ordered-list',
  'rte-link',
];

describe('RichTextEditor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all toolbar buttons by data-testid', () => {
    render(
      <RichTextEditor value="" onChange={() => {}} ariaLabel="Proposal text" testId="rte-test" />,
    );
    for (const testId of TOOLBAR_TESTIDS) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
  });

  it('exposes the editable region with the provided aria-label and testId', () => {
    render(
      <RichTextEditor value="<p>Hello</p>" onChange={() => {}} ariaLabel="Proposal text" testId="rte-test" />,
    );
    const editable = screen.getByTestId('rte-test');
    expect(editable).toHaveAttribute('contenteditable', 'true');
    expect(editable).toHaveAttribute('aria-label', 'Proposal text');
    expect(editable.textContent).toContain('Hello');
  });

  it('emits subset HTML through onChange when a toolbar command runs', async () => {
    const onChange = vi.fn();
    render(
      <RichTextEditor value="<p>Hello</p>" onChange={onChange} ariaLabel="Proposal text" testId="rte-test" />,
    );
    fireEvent.click(screen.getByTestId('rte-bullet-list'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const emitted = onChange.mock.calls.at(-1)?.[0] as string;
    expect(emitted).toContain('<ul>');
    // Nothing outside the sanitizer subset should ever be produced.
    expect(emitted).not.toMatch(/<script|<blockquote|<pre|<code|<hr/);
  });

  it('normalizes marks to the subset (strong/em/u), never <b>/<i>', () => {
    // Legacy-style tags must parse into the sanitizer subset: <b> -> <strong>,
    // <i> -> <em>. This proves the editor can never re-emit the disallowed tags.
    render(
      <RichTextEditor
        value="<p><b>Bold</b> <i>Ital</i> <u>Und</u></p>"
        onChange={() => {}}
        ariaLabel="Proposal text"
        testId="rte-test"
      />,
    );
    const editable = screen.getByTestId('rte-test');
    expect(editable.querySelector('strong')).not.toBeNull();
    expect(editable.querySelector('em')).not.toBeNull();
    expect(editable.querySelector('u')).not.toBeNull();
    expect(editable.querySelector('b')).toBeNull();
    expect(editable.querySelector('i')).toBeNull();
  });

  it('strips content outside the allowed subset (blockquote/code)', () => {
    render(
      <RichTextEditor
        value="<blockquote><p>Quote</p></blockquote><pre><code>x=1</code></pre><p>Body</p>"
        onChange={() => {}}
        ariaLabel="Proposal text"
        testId="rte-test"
      />,
    );
    const editable = screen.getByTestId('rte-test');
    expect(editable.querySelector('blockquote')).toBeNull();
    expect(editable.querySelector('pre')).toBeNull();
    expect(editable.querySelector('code')).toBeNull();
    expect(editable.textContent).toContain('Body');
  });
});
