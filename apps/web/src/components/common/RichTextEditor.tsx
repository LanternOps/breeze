import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';

export interface RichTextEditorProps {
  /** Current HTML value (already constrained to the sanitizer subset). */
  value: string;
  /** Fired with `editor.getHTML()` whenever the document changes. */
  onChange: (html: string) => void;
  /** Accessible label for the editable region. */
  ariaLabel: string;
  /** `data-testid` applied to the editable region. */
  testId: string;
}

// Only http/https (or scheme-less relative) URLs are accepted — matching the API
// sanitizer (richTextSanitize.ts). TipTap's `protocols` option only EXTENDS the
// default allowlist (which includes mailto:/tel:/ftp:), so those would be
// accepted here and then silently stripped server-side; a custom isAllowedUri is
// the only way to actually reject them in the editor.
function isHttpOrHttpsUri(uri: string): boolean {
  const trimmed = uri.trim();
  // Protocol-relative (`//evil.example`) carries no scheme but still navigates
  // off-origin under the page's own scheme. The server rejects it
  // (richTextSanitize.ts allowProtocolRelative:false), so reject it here too —
  // otherwise the editor accepts a link the sanitizer would silently strip.
  if (trimmed.startsWith('//')) return false;
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (!scheme) return true; // scheme-less relative URL (e.g. /path) — the sanitizer permits these
  return scheme === 'http' || scheme === 'https';
}

// The editor is deliberately constrained to the rich-text subset the API
// sanitizer accepts: p, br, strong, em, u, h3, h4, ul, ol, li, a[href]. Anything
// StarterKit would otherwise add (code, code blocks, blockquotes, strike,
// horizontal rules) is disabled so the editor can never emit markup the server
// would strip. Link + Underline are added standalone (StarterKit's own copies
// are disabled below to avoid duplicate-extension registration) so we can pin
// safe protocols and non-navigating links.
function buildExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [3, 4] },
      code: false,
      codeBlock: false,
      blockquote: false,
      strike: false,
      horizontalRule: false,
      // Configured explicitly below.
      link: false,
      underline: false,
    }),
    Underline,
    Link.configure({
      openOnClick: false,
      protocols: ['http', 'https'],
      autolink: false,
      // Emit exactly the rel the server sanitizer settles on (richTextSanitize.ts
      // forces rel="noopener noreferrer"). TipTap's default adds a trailing
      // `nofollow`, so its output would never string-equal the stored/sanitized
      // HTML — leaving a link-bearing rich_text block permanently "unsaved" and
      // re-PATCHing on every blur. Overriding rel here closes that gap; target
      // keeps TipTap's `_blank` default (which the sanitizer also forces).
      HTMLAttributes: { rel: 'noopener noreferrer' },
      // Actually enforce the allowlist — protocols alone doesn't reject extras.
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
      // Keep the editor selection intact: a plain click would blur the
      // contenteditable before the command runs, collapsing the selection.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`inline-flex h-7 min-w-7 items-center justify-center rounded px-2 text-sm font-medium transition-colors ${
        isActive
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-muted'
      }`}
    >
      {label}
    </button>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const { t } = useTranslation('common');
  const setLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined;
    const input = window.prompt(t('richTextEditor.linkPrompt'), previous ?? 'https://');
    if (input === null) return; // cancelled
    const url = input.trim();
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    // Reject anything the sanitizer would strip (mailto:/tel:/ftp:/javascript:…)
    // with a clear message instead of silently dropping the link server-side.
    if (!isHttpOrHttpsUri(url)) {
      window.alert(t('richTextEditor.linkInvalid'));
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1 border-b bg-muted/40 px-2 py-1"
      role="toolbar"
      aria-label={t('richTextEditor.toolbarAria')}
    >
      <ToolbarButton
        testId="rte-bold"
        label={t('richTextEditor.bold')}
        isActive={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <ToolbarButton
        testId="rte-italic"
        label={t('richTextEditor.italic')}
        isActive={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <ToolbarButton
        testId="rte-underline"
        label={t('richTextEditor.underline')}
        isActive={editor.isActive('underline')}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      />
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      <ToolbarButton
        testId="rte-h3"
        label={t('richTextEditor.heading3')}
        isActive={editor.isActive('heading', { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      />
      <ToolbarButton
        testId="rte-h4"
        label={t('richTextEditor.heading4')}
        isActive={editor.isActive('heading', { level: 4 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 4 }).run()}
      />
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      <ToolbarButton
        testId="rte-bullet-list"
        label={t('richTextEditor.bulletList')}
        isActive={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <ToolbarButton
        testId="rte-ordered-list"
        label={t('richTextEditor.orderedList')}
        isActive={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      <ToolbarButton
        testId="rte-link"
        label={t('richTextEditor.link')}
        isActive={editor.isActive('link')}
        onClick={setLink}
      />
    </div>
  );
}

export default function RichTextEditor({ value, onChange, ariaLabel, testId }: RichTextEditorProps) {
  const editor = useEditor({
    extensions: buildExtensions(),
    content: value,
    // React island: never render immediately on the server, and match jsdom
    // where document is present at mount.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        'aria-label': ariaLabel,
        'data-testid': testId,
        role: 'textbox',
        'aria-multiline': 'true',
        class:
          'prose prose-sm max-w-none min-h-24 px-3 py-2 text-sm focus:outline-hidden',
      },
    },
    onUpdate: ({ editor: e }) => {
      onChange(e.getHTML());
    },
  });

  // Keep the editor in sync when the value prop changes from outside (e.g. a
  // server refresh resets the persisted HTML). Skip when the incoming value
  // already matches to avoid clobbering the user's cursor mid-edit.
  useEffect(() => {
    if (!editor) return;
    if (value !== editor.getHTML()) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [value, editor]);

  return (
    <div className="rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring">
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}
