// Document theme registry for the proposal presentation system (Task 4).
//
// A "theme" controls which font family a rendered proposal/quote PDF uses.
// `classic` is the long-standing default and deliberately resolves to
// pdfkit's built-in Helvetica family — zero file I/O, zero registration —
// so existing renderers that don't opt into theming keep producing byte-for-
// byte the same output they do today.
//
// `condensed` is the new theme: Barlow Condensed for headings, DM Sans for
// body copy. Both are OFL-licensed and vendored under apps/api/assets/fonts
// (see that directory's OFL-*.txt files for license text). Only one heading
// weight (SemiBold) is vendored by design, so both the heading.regular and
// heading.bold slots resolve to the same registered face.
//
// registerThemeFonts THROWS if a condensed font file is missing rather than
// silently falling back to Helvetica — a silent fallback would ship a
// document that looks subtly wrong with no signal to anyone (spec §3).

import fs from 'node:fs';
import path from 'node:path';

export type DocumentThemeId = 'classic' | 'condensed';
export type DocumentPageSize = 'letter' | 'a4';

export interface PdfThemeFonts {
  heading: { regular: string; bold: string };
  body: { regular: string; bold: string; italic: string; boldItalic: string };
}

// Resolved once at module load. tsup bundles this into apps/api/dist, and the
// API runs with cwd() = apps/api (see Dockerfile WORKDIR / package.json
// `start` script), so `process.cwd()/assets/fonts` is the primary path in
// both dev (ts-node/tsx from the apps/api dir) and production (Docker runner
// WORKDIR /app/apps/api). The __dirname-relative fallback covers any run
// context where cwd isn't apps/api (e.g. a test runner invoked from repo
// root) — dist/services/documentThemes.cjs -> ../../assets/fonts is
// apps/api/assets/fonts; the same relative depth also works from
// src/services during ts-node execution.
const FONT_DIR = resolveFontDir();

function resolveFontDir(): string {
  const fromCwd = path.resolve(process.cwd(), 'assets/fonts');
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.resolve(__dirname, '../../assets/fonts');
}

export { FONT_DIR };

const CONDENSED_FONT_FILES = {
  'Doc-Heading': 'BarlowCondensed-SemiBold.ttf',
  'Doc-Body': 'DMSans-Regular.ttf',
  'Doc-Body-Bold': 'DMSans-Bold.ttf',
  'Doc-Body-Italic': 'DMSans-Italic.ttf',
  'Doc-Body-BoldItalic': 'DMSans-BoldItalic.ttf',
} as const;

const CLASSIC_FONTS: PdfThemeFonts = {
  heading: { regular: 'Helvetica', bold: 'Helvetica-Bold' },
  body: {
    regular: 'Helvetica',
    bold: 'Helvetica-Bold',
    italic: 'Helvetica-Oblique',
    boldItalic: 'Helvetica-BoldOblique',
  },
};

// Only one heading weight (SemiBold) is vendored, so both heading slots point
// at the same registered face — see module doc comment.
const CONDENSED_FONTS: PdfThemeFonts = {
  heading: { regular: 'Doc-Heading', bold: 'Doc-Heading' },
  body: {
    regular: 'Doc-Body',
    bold: 'Doc-Body-Bold',
    italic: 'Doc-Body-Italic',
    boldItalic: 'Doc-Body-BoldItalic',
  },
};

export function resolveThemeId(raw: string | null | undefined): DocumentThemeId {
  return raw === 'condensed' ? 'condensed' : 'classic';
}

export function resolvePageSize(raw: string | null | undefined): DocumentPageSize {
  return raw === 'letter' ? 'letter' : 'a4';
}

export function pdfPageSize(size: DocumentPageSize): 'LETTER' | 'A4' {
  return size === 'letter' ? 'LETTER' : 'A4';
}

/**
 * Registers the theme's font files on `doc` (no-op for classic) and returns
 * the font-name table to draw with. THROWS if a font file is missing — a
 * silent Helvetica fallback would ship wrong documents (spec §3).
 */
export function registerThemeFonts(doc: PDFKit.PDFDocument, theme: DocumentThemeId): PdfThemeFonts {
  if (theme === 'classic') return CLASSIC_FONTS;

  for (const [fontName, fileName] of Object.entries(CONDENSED_FONT_FILES)) {
    const filePath = path.join(FONT_DIR, fileName);
    try {
      fs.accessSync(filePath, fs.constants.R_OK);
    } catch {
      throw new Error(`document theme font missing: ${filePath}`);
    }
    doc.registerFont(fontName, filePath);
  }

  return CONDENSED_FONTS;
}
