import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Node as TiptapNode } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';

// A hard schema-level cap: StarterKit's own Document node accepts `block+`
// (any number of paragraphs), which would let a paste insert extra
// paragraphs even though typed Enter is swallowed (see handleKeyDown below —
// that only guards keyboard input, not a paste's document-slice insertion).
// Overriding just the top node's content expression to a single `paragraph`
// makes "one paragraph, always" a property of the schema itself: ProseMirror
// cannot construct a second block-level child no matter which path tries to
// insert one.
const SingleParagraphDocument = TiptapNode.create({
  name: 'doc',
  topNode: true,
  content: 'paragraph',
});

export interface InlineRichTextEditorProps {
  /** Current HTML value, constrained to the inline subset (strong/em/u/a/br). */
  value: string;
  /** Fired with `editor.getHTML()` whenever the document changes. */
  onChange: (html: string) => void;
  /** Accessible label for the editable region. */
  ariaLabel: string;
  /** `data-testid` applied to the editable region; toolbar buttons are
   *  namespaced off this so many instances (e.g. one per table cell) can
   *  render side by side without colliding testids. */
  testId: string;
  /** Optional cap on the emitted HTML string length, mirroring the server
   *  validator it feeds (e.g. quoteTableContentSchema's cell `z.string().max(2000)`).
   *  An edit that would push `getHTML()` over the cap is reverted rather than
   *  propagated — client-side defense so the field never drifts into a shape
   *  the server would 422 on. */
  maxLength?: number;
}

// Same allowlist logic as RichTextEditor.tsx — kept in sync deliberately
// rather than shared, since the two editors' import graphs are meant to stay
// independent (this one must never grow a dependency that pulls in
// block-level extensions).
function isHttpOrHttpsUri(uri: string): boolean {
  const trimmed = uri.trim();
  if (trimmed.startsWith('//')) return false;
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (!scheme) return true;
  return scheme === 'http' || scheme === 'https';
}

// Flattens arbitrary pasted HTML down to the inline subset the schema (and the
// server's inline richTextSanitize profile) accept: strong, em, u, a, br. Runs
// BEFORE ProseMirror's paste-HTML parser, so it's the thing standing between
// "pasted a whole formatted document" and a doc that only ever contains one
// paragraph — the schema alone doesn't stop a paste from inserting extra
// paragraph/heading/list nodes, since Enter-swallowing only guards typing.
// Block-level boundaries (p/div/li/headings) become a <br> so multi-line
// pasted text doesn't collapse into one run-on word.
function sanitizeToInlineHtml(html: string): string {
  const container = document.createElement('div');
  container.innerHTML = html;

  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TR']);

  function walk(node: ChildNode, isLast: boolean): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as HTMLElement;
    const tag = el.tagName;
    const kids = Array.from(el.childNodes);
    const inner = kids.map((k, i) => walk(k, i === kids.length - 1)).join('');

    if (tag === 'BR') return '<br>';
    if (tag === 'STRONG' || tag === 'B') return `<strong>${inner}</strong>`;
    if (tag === 'EM' || tag === 'I') return `<em>${inner}</em>`;
    if (tag === 'U') return `<u>${inner}</u>`;
    if (tag === 'A') {
      const href = el.getAttribute('href');
      return href && isHttpOrHttpsUri(href) ? `<a href="${href}">${inner}</a>` : inner;
    }
    // Any other tag (script/style included) is unwrapped to its inline
    // content — nothing outside the allowlist above is ever re-emitted.
    if (tag === 'SCRIPT' || tag === 'STYLE') return '';
    return BLOCK_TAGS.has(tag) && !isLast ? `${inner}<br>` : inner;
  }

  const top = Array.from(container.childNodes);
  return top.map((n, i) => walk(n, i === top.length - 1)).join('');
}

// The document/paragraph/text/bold/italic node & mark set IS StarterKit's
// minimal core — everything else it would otherwise register (headings,
// lists, blockquote, code, horizontal rule, strike) is switched off so the
// schema itself can never accept a second block or a disallowed mark.
// Underline + Link are added standalone, same idiom as RichTextEditor.tsx.
function buildExtensions() {
  return [
    SingleParagraphDocument,
    StarterKit.configure({
      document: false,
      heading: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      code: false,
      codeBlock: false,
      blockquote: false,
      horizontalRule: false,
      strike: false,
      link: false,
      underline: false,
    }),
    Underline,
    Link.configure({
      openOnClick: false,
      protocols: ['http', 'https'],
      autolink: false,
      HTMLAttributes: { rel: 'noopener noreferrer' },
      isAllowedUri: (uri) => isHttpOrHttpsUri(uri),
    }),
  ];
}

interface ToolbarButtonProps {
  testId: string;
  label: string;
  isActive: boolean;
  onClick: () => void;
}

function ToolbarButton({ testId, label, isActive, onClick }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-pressed={isActive}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 text-xs font-medium transition-colors ${
        isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
      }`}
    >
      {label}
    </button>
  );
}

function Toolbar({ editor, testId }: { editor: Editor; testId: string }) {
  const { t } = useTranslation('common');

  // Marks apply to the whole cell in one click rather than requiring the user
  // to drag-select first — a deliberate simplification for a single-line cell
  // editor (see InlineRichTextEditor.test.tsx). selectAll is a ProseMirror
  // command over the document model, not the DOM Selection API, so it also
  // keeps this reliably testable.
  const applyMark = (toggle: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => {
    toggle(editor.chain().focus().selectAll()).run();
  };

  const setLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined;
    const input = window.prompt(t('richTextEditor.linkPrompt'), previous ?? 'https://');
    if (input === null) return;
    const url = input.trim();
    if (url === '') {
      editor.chain().focus().selectAll().unsetLink().run();
      return;
    }
    if (!isHttpOrHttpsUri(url)) {
      window.alert(t('richTextEditor.linkInvalid'));
      return;
    }
    editor.chain().focus().selectAll().setLink({ href: url }).run();
  };

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 px-1 py-0.5" role="toolbar" aria-label={t('richTextEditor.toolbarAria')}>
      <ToolbarButton
        testId={`${testId}-bold`}
        label={t('richTextEditor.bold')}
        isActive={editor.isActive('bold')}
        onClick={() => applyMark((c) => c.toggleBold())}
      />
      <ToolbarButton
        testId={`${testId}-italic`}
        label={t('richTextEditor.italic')}
        isActive={editor.isActive('italic')}
        onClick={() => applyMark((c) => c.toggleItalic())}
      />
      <ToolbarButton
        testId={`${testId}-underline`}
        label={t('richTextEditor.underline')}
        isActive={editor.isActive('underline')}
        onClick={() => applyMark((c) => c.toggleUnderline())}
      />
      <ToolbarButton
        testId={`${testId}-link`}
        label={t('richTextEditor.link')}
        isActive={editor.isActive('link')}
        onClick={setLink}
      />
    </div>
  );
}

export default function InlineRichTextEditor({ value, onChange, ariaLabel, testId, maxLength }: InlineRichTextEditorProps) {
  const editor = useEditor({
    extensions: buildExtensions(),
    content: value,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        'aria-label': ariaLabel,
        'data-testid': testId,
        role: 'textbox',
        'aria-multiline': 'false',
        class: 'min-h-8 px-2 py-1 text-sm focus:outline-hidden',
      },
      // Enter never creates a second paragraph — this is a single-line cell
      // editor. Returning true marks the keydown handled so ProseMirror's own
      // Enter keymap (splitBlock) never runs.
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          return true;
        }
        return false;
      },
      transformPastedHTML: (html) => sanitizeToInlineHtml(html),
    },
    onUpdate: ({ editor: e }) => {
      const html = e.getHTML();
      if (maxLength != null && html.length > maxLength) {
        // Revert rather than truncate: truncating mid-tag could produce
        // malformed HTML, and undo cleanly restores the last valid state.
        e.commands.undo();
        return;
      }
      onChange(html);
    },
  });

  useEffect(() => {
    if (!editor) return;
    if (value !== editor.getHTML()) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [value, editor]);

  return (
    <div className="rounded border bg-background focus-within:ring-2 focus-within:ring-ring">
      {editor && <Toolbar editor={editor} testId={testId} />}
      <EditorContent editor={editor} />
    </div>
  );
}
