/**
 * Attachments in import mode, the rules (#8313 W1; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §4.3, §4.4): the executable denylist (each extension, each header), the
 * sniff to stored type table, the skip reasons and the note, sanitized
 * filenames and the provisional metadata of a reservation. The two
 * statements run against Postgres in ticketImportAttachments.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  attachmentSkipNote,
  ATTACHMENT_SKIP_NOTE_PG_PATTERN,
  EXECUTABLE_EXTENSIONS,
  EXECUTABLE_HEADERS,
  fetchedBytesSkip,
  finalExtension,
  hasExecutableHeader,
  IMPORT_ATTACHMENT_MAX_BYTES,
  importedAttachmentFilename,
  isBlockedFilename,
  PROVISIONAL_CONTENT_TYPE,
  PROVISIONAL_SHA256,
  provisionalByteSize,
  reservationSkip,
  sniffImportedAttachment,
  stripAttachmentSkipNote,
  withAttachmentSkipNote,
} from './importAttachments';

const MIB = 1024 * 1024;

const bytes = (...head: number[]) => Buffer.concat([Buffer.from(head), Buffer.alloc(32, 0x41)]);
const ascii = (text: string) => Buffer.from(text, 'latin1');

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const WEBP = Buffer.concat([ascii('RIFF'), Buffer.from([0x24, 0, 0, 0]), ascii('WEBPVP8 '), Buffer.alloc(32)]);
const PDF = ascii('%PDF-1.7\n%âãÏÓ\n1 0 obj');

describe('the executable denylist (decision 1, §4.4)', () => {
  it('pins every extension: the spec\'s, then the W1 review\'s additions', () => {
    expect([...EXECUTABLE_EXTENSIONS]).toEqual([
      'exe', 'dll', 'com', 'scr', 'pif', 'cpl', 'msi', 'msp', 'msix', 'appx',
      'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
      'jar', 'lnk', 'reg', 'scf', 'inf', 'sh', 'app', 'dmg', 'pkg',
      'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm',
      'xlsb', 'xla', 'xlm', 'xll',
      'chm', 'msc', 'url', 'application', 'appref-ms', 'ws', 'wsc', 'vb', 'gadget', 'website',
      'settingcontent-ms', 'diagcab', 'library-ms', 'search-ms', 'searchconnector-ms',
      'iso', 'img', 'vhd', 'vhdx',
    ]);
  });

  it('keeps legacy OLE Office files, archived pages and ordinary documents (the residual risk is named, not blocked)', () => {
    for (const name of ['minutes.doc', 'budget.xls', 'deck.ppt', 'page.mht', 'page.mhtml', 'report.docx', 'sheet.xlsx', 'logs.zip', 'mail.eml']) {
      expect(isBlockedFilename(name), name).toBe(false);
    }
    // A hyphenated extension is one extension.
    expect(finalExtension('Control Panel.settingcontent-ms')).toBe('settingcontent-ms');
    expect(isBlockedFilename('Install.APPREF-MS')).toBe(true);
  });

  it.each(EXECUTABLE_EXTENSIONS.map((ext) => [ext]))('blocks a .%s file, in any case', (ext) => {
    expect(isBlockedFilename(`setup.${ext}`)).toBe(true);
    expect(isBlockedFilename(`SETUP.${ext.toUpperCase()}`)).toBe(true);
    expect(reservationSkip(1024, `setup.${ext}`)).toBe('blocked_type');
  });

  it('compares the FINAL extension: a double extension is blocked, an executable name with a safe extension is not', () => {
    expect(isBlockedFilename('invoice.pdf.exe')).toBe(true);
    expect(isBlockedFilename('Invoice.PDF.Exe')).toBe(true);
    expect(isBlockedFilename('setup.exe.txt')).toBe(false);
    expect(isBlockedFilename('report.pdf')).toBe(false);
    expect(isBlockedFilename('archive.zip')).toBe(false);
    expect(isBlockedFilename('minutes.docx')).toBe(false);
    expect(isBlockedFilename('budget.xlsx')).toBe(false);
  });

  it('trims trailing dots and spaces first (Windows ignores them)', () => {
    expect(isBlockedFilename('setup.EXE.')).toBe(true);
    expect(isBlockedFilename('setup.exe . .')).toBe(true);
    expect(isBlockedFilename('macro.xlsm   ')).toBe(true);
    expect(finalExtension('setup.EXE..')).toBe('exe');
  });

  it('a name with no dot has no extension, and is not blocked by name', () => {
    expect(finalExtension('exe')).toBeNull();
    expect(isBlockedFilename('exe')).toBe(false);
    expect(isBlockedFilename('Makefile')).toBe(false);
  });

  it('pins every header the spec lists: PE, ELF, Mach-O in both byte orders, and the universal header', () => {
    expect(EXECUTABLE_HEADERS.map((h) => [h.name, Buffer.from(h.magic).toString('hex')])).toEqual([
      ['PE (MZ)', '4d5a'],
      ['ELF', '7f454c46'],
      ['Mach-O 32-bit, big-endian', 'feedface'],
      ['Mach-O 64-bit, big-endian', 'feedfacf'],
      ['Mach-O 32-bit, little-endian', 'cefaedfe'],
      ['Mach-O 64-bit, little-endian', 'cffaedfe'],
      ['Mach-O universal', 'cafebabe'],
      ['Mach-O universal, little-endian', 'bebafeca'],
      ['Mach-O universal 64-bit', 'cafebabf'],
    ]);
  });

  it.each(EXECUTABLE_HEADERS.map((h) => [h.name, h.magic]))('blocks a %s header whatever the name', (_name, magic) => {
    const buf = bytes(...magic);
    expect(hasExecutableHeader(buf)).toBe(true);
    expect(sniffImportedAttachment(buf)).toEqual({ blocked: true });
  });

  it('needs the whole header at offset 0', () => {
    expect(hasExecutableHeader(Buffer.from([0x4d]))).toBe(false);
    expect(hasExecutableHeader(Buffer.from([0x7f, 0x45, 0x4c]))).toBe(false);
    expect(hasExecutableHeader(Buffer.concat([Buffer.from([0x20]), bytes(0x4d, 0x5a)]))).toBe(false);
    expect(hasExecutableHeader(Buffer.alloc(0))).toBe(false);
  });
});

describe('sniff to stored type (§4.4)', () => {
  it.each([
    ['JPEG', JPEG, 'image/jpeg'],
    ['PNG', PNG, 'image/png'],
    ['WebP', WEBP, 'image/webp'],
    ['PDF', PDF, 'application/pdf'],
  ])('%s keeps its sniffed type', (_name, buf, type) => {
    expect(sniffImportedAttachment(buf)).toEqual({ blocked: false, contentType: type });
  });

  it.each([
    ['an Office file (ZIP container)', bytes(0x50, 0x4b, 0x03, 0x04)],
    ['a ZIP', bytes(0x50, 0x4b, 0x05, 0x06)],
    ['an EML', ascii('From: a@example.test\r\nSubject: hi\r\n\r\nbody')],
    ['a TXT', ascii('plain text notes')],
    ['a GIF', ascii('GIF89a\x01\x00\x01\x00')],
    ['an SVG', ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['an HTML page', ascii('<!doctype html><html><body>hi</body></html>')],
    ['a legacy Office file (OLE)', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)],
  ])('%s is stored as application/octet-stream (served download-only)', (_name, buf) => {
    expect(sniffImportedAttachment(buf)).toEqual({ blocked: false, contentType: 'application/octet-stream' });
  });

  it('never looks at the name or a declared type: a PNG named .pdf stays image/png', () => {
    expect(sniffImportedAttachment(PNG)).toEqual({ blocked: false, contentType: 'image/png' });
  });
});

describe('skip reasons (§4.4)', () => {
  it('a declared size over the cap is too_large and zero is empty, before any fetch; the cap itself passes', () => {
    expect(reservationSkip(IMPORT_ATTACHMENT_MAX_BYTES + 1, 'big.zip')).toBe('too_large');
    expect(reservationSkip(IMPORT_ATTACHMENT_MAX_BYTES, 'big.zip')).toBeNull();
    expect(reservationSkip(0, 'empty.txt')).toBe('empty');
    expect(reservationSkip(undefined, 'unknown.bin')).toBeNull();
  });

  it('a denylisted name wins over its size', () => {
    expect(reservationSkip(IMPORT_ATTACHMENT_MAX_BYTES + 1, 'setup.exe')).toBe('blocked_type');
    expect(reservationSkip(0, 'setup.exe')).toBe('blocked_type');
  });

  it('fetched bytes over the cap are too_large and none are empty (the size CHECK refuses 0)', () => {
    expect(IMPORT_ATTACHMENT_MAX_BYTES).toBe(10 * MIB);
    expect(fetchedBytesSkip(10 * MIB + 1)).toBe('too_large');
    expect(fetchedBytesSkip(10 * MIB)).toBeNull();
    expect(fetchedBytesSkip(0)).toBe('empty');
    expect(fetchedBytesSkip(1)).toBeNull();
  });
});

describe('the note appended to a comment (§4.4, the inbound shape F8)', () => {
  it('names each skipped file and why, in order', () => {
    expect(attachmentSkipNote([
      { filename: 'a.zip', reason: 'too_large' },
      { filename: 'b.exe', reason: 'blocked_type' },
      { filename: 'c.txt', reason: 'empty' },
      { filename: 'd.pdf', reason: 'not_found' },
    ])).toBe('[Attachments not imported: a.zip (over the 10 MB limit); b.exe (blocked file type); c.txt (empty file); d.pdf (not found in the source)]');
  });

  it('names at most ten, then counts the rest', () => {
    const skips = Array.from({ length: 13 }, (_, i) => ({ filename: `f${i}.zip`, reason: 'too_large' as const }));
    const note = attachmentSkipNote(skips)!;
    expect(note).toContain('f9.zip (over the 10 MB limit); and 3 more]');
    expect(note).not.toContain('f10.zip');
  });

  it('never names a file present elsewhere (it is in Breeze)', () => {
    expect(attachmentSkipNote([{ filename: 'a.png', reason: 'present_elsewhere' }])).toBeNull();
    expect(attachmentSkipNote([{ filename: 'a.png', reason: 'present_elsewhere' }, { filename: 'b.exe', reason: 'blocked_type' }]))
      .toBe('[Attachments not imported: b.exe (blocked file type)]');
  });

  it('strips a trailing note on the JS side exactly as the SQL does on the stored side', () => {
    expect(stripAttachmentSkipNote('Body\n\n[Attachments not imported: a.zip (over the 10 MB limit)]')).toBe('Body');
    expect(stripAttachmentSkipNote('[Attachments not imported: a.zip (empty file)]')).toBe('');
    expect(stripAttachmentSkipNote('Body without a note')).toBe('Body without a note');
  });

  it('is null with no skip, and appended on its own line otherwise', () => {
    expect(attachmentSkipNote([])).toBeNull();
    expect(withAttachmentSkipNote('Body', [])).toBe('Body');
    expect(withAttachmentSkipNote('Body', [{ filename: 'x.exe', reason: 'blocked_type' }]))
      .toBe('Body\n\n[Attachments not imported: x.exe (blocked file type)]');
    expect(withAttachmentSkipNote('', [{ filename: 'x.exe', reason: 'blocked_type' }]))
      .toBe('[Attachments not imported: x.exe (blocked file type)]');
  });

  it('the report pattern strips exactly the note (checked here with the same expression in JS)', () => {
    const pattern = new RegExp(ATTACHMENT_SKIP_NOTE_PG_PATTERN);
    const skips = [{ filename: 'report[1].pdf', reason: 'not_found' as const }];
    expect(withAttachmentSkipNote('Body\nline 2', skips).replace(pattern, '')).toBe('Body\nline 2');
    expect(withAttachmentSkipNote('', skips).replace(pattern, '')).toBe('');
    // Text that only mentions the phrase mid-body is left alone.
    expect('see [Attachments not imported: x]\nmore'.replace(pattern, '')).toBe('see [Attachments not imported: x]\nmore');
    expect('[Email attachments not imported: a.zip (file type not supported)]'.replace(pattern, ''))
      .toBe('[Email attachments not imported: a.zip (file type not supported)]');
  });
});

describe('filenames and provisional metadata (§4.3)', () => {
  it('sanitizes like the live upload route: basename, no quotes, backslashes or control characters', () => {
    expect(importedAttachmentFilename('C:\\Users\\maya\\invoice.pdf')).toBe('invoice.pdf');
    expect(importedAttachmentFilename('../../etc/passwd')).toBe('passwd');
    expect(importedAttachmentFilename('a"b\r\nc.txt')).toBe('abc.txt');
    expect(importedAttachmentFilename('')).toBe('attachment');
    expect(importedAttachmentFilename('x'.repeat(400) + '.pdf')).toHaveLength(255);
  });

  it('a reservation carries the declared size clamped into the size CHECK, the generic type and a zero digest', () => {
    expect(provisionalByteSize(undefined)).toBe(1);
    expect(provisionalByteSize(0)).toBe(1);
    expect(provisionalByteSize(4096)).toBe(4096);
    expect(provisionalByteSize(50 * MIB)).toBe(10 * MIB);
    expect(PROVISIONAL_CONTENT_TYPE).toBe('application/octet-stream');
    expect(PROVISIONAL_SHA256).toBe('0'.repeat(64));
  });
});
