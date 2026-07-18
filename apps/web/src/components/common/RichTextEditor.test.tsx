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

  it('rejects a non-http(s) link scheme (mailto:) with a validation alert and sets no link', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('mailto:evil@example.com');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onChange = vi.fn();
    render(
      <RichTextEditor value="<p>Hello</p>" onChange={onChange} ariaLabel="Proposal text" testId="rte-test" />,
    );

    fireEvent.click(screen.getByTestId('rte-link'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(promptSpy).toHaveBeenCalled();
    // The disallowed scheme must never make it into emitted HTML.
    const emitted = onChange.mock.calls.map((c) => c[0] as string).join('');
    expect(emitted).not.toContain('mailto:');
  });

  it('rejects a protocol-relative link (//host) with a validation alert and sets no link', async () => {
    // The server sanitizer (richTextSanitize.ts, allowProtocolRelative:false)
    // strips `//evil.example`, so the editor must reject it up front rather than
    // accept a link the server will silently drop.
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('//evil.example');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onChange = vi.fn();
    render(
      <RichTextEditor value="<p>Hello</p>" onChange={onChange} ariaLabel="Proposal text" testId="rte-test" />,
    );

    fireEvent.click(screen.getByTestId('rte-link'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(promptSpy).toHaveBeenCalled();
    const emitted = onChange.mock.calls.map((c) => c[0] as string).join('');
    expect(emitted).not.toContain('//evil.example');
  });

  it('renders links with rel="noopener noreferrer" (no nofollow) matching the server sanitizer', () => {
    // TipTap's Link default adds a trailing `nofollow`; the sanitizer stores
    // rel="noopener noreferrer". The editor is configured to emit the sanitizer's
    // exact rel so a link-bearing block settles to "saved" instead of re-PATCHing.
    render(
      <RichTextEditor
        value='<p><a href="https://ex.com">Link</a></p>'
        onChange={() => {}}
        ariaLabel="Proposal text"
        testId="rte-test"
      />,
    );
    const anchor = screen.getByTestId('rte-test').querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor?.getAttribute('rel')).not.toContain('nofollow');
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
