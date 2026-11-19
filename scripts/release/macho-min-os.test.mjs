import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMachOMinOs } from './macho-min-os.mjs';

const LC_BUILD_VERSION = 0x32;
const LC_VERSION_MIN_MACOSX = 0x24;

function header(ncmds, sizeofcmds, magic = 0xfeedfacf) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(magic, 0);
  h.writeUInt32LE(0x0100000c, 4); // cputype arm64
  h.writeUInt32LE(2, 12); // MH_EXECUTE
  h.writeUInt32LE(ncmds, 16);
  h.writeUInt32LE(sizeofcmds, 20);
  return h;
}

function buildVersionCmd(minos) {
  const c = Buffer.alloc(24);
  c.writeUInt32LE(LC_BUILD_VERSION, 0);
  c.writeUInt32LE(24, 4);
  c.writeUInt32LE(1, 8); // PLATFORM_MACOS
  c.writeUInt32LE(minos, 12);
  c.writeUInt32LE(0x000f0000, 16); // sdk
  return c;
}

function versionMinCmd(version) {
  const c = Buffer.alloc(16);
  c.writeUInt32LE(LC_VERSION_MIN_MACOSX, 0);
  c.writeUInt32LE(16, 4);
  c.writeUInt32LE(version, 8);
  c.writeUInt32LE(0x000f0000, 12);
  return c;
}

function macho(cmd) {
  return Buffer.concat([header(1, cmd.length), cmd]);
}

test('reads LC_BUILD_VERSION minos', () => {
  assert.equal(readMachOMinOs(macho(buildVersionCmd(0x000d0000))), '13.0');
  assert.equal(readMachOMinOs(macho(buildVersionCmd(0x000c0700))), '12.7');
  assert.equal(readMachOMinOs(macho(buildVersionCmd(0x000f0801))), '15.8.1');
});

test('falls back to LC_VERSION_MIN_MACOSX', () => {
  assert.equal(readMachOMinOs(macho(versionMinCmd(0x000a0f00))), '10.15');
});

test('returns null for fat, truncated, ELF, and no-version-command inputs', () => {
  const fat = Buffer.alloc(64);
  fat.writeUInt32BE(0xcafebabe, 0);
  assert.equal(readMachOMinOs(fat), null);
  const good = macho(buildVersionCmd(0x000d0000));
  assert.equal(readMachOMinOs(good.subarray(0, 40)), null);
  assert.equal(readMachOMinOs(good.subarray(0, 10)), null);
  const elf = Buffer.alloc(64);
  elf.write('\x7fELF', 0, 'latin1');
  assert.equal(readMachOMinOs(elf), null);
  const other = Buffer.alloc(16);
  other.writeUInt32LE(0x19, 0); // LC_SEGMENT_64
  other.writeUInt32LE(16, 4);
  assert.equal(readMachOMinOs(macho(other)), null);
});
