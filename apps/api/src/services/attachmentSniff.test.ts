import { describe, it, expect } from 'vitest';
import { sniffAttachmentMime } from './attachmentSniff';

const pad = (head: number[]) => Buffer.from([...head, ...Array(16).fill(0)]);

describe('sniffAttachmentMime', () => {
  const cases: Array<[string, Buffer, string | null]> = [
    ['png', pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
    ['jpeg', pad([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
    ['webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 \0\0\0\0'), 'image/webp'],
    ['pdf', Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'), 'application/pdf'],
    ['heic (ftypheic) is rejected', Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic', 'latin1'), null],
    ['svg is rejected', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), null],
    ['html is rejected', Buffer.from('<!doctype html><html></html>'), null],
    ['a PDF header not at offset 0 is rejected', Buffer.from('  %PDF-1.7\n', 'latin1'), null],
    ['too short', Buffer.from([0x89, 0x50]), null],
    ['empty', Buffer.alloc(0), null],
  ];
  it.each(cases)('%s', (_name, buf, expected) => {
    expect(sniffAttachmentMime(buf)).toBe(expected);
  });
});
