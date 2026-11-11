import { describe, expect, it } from 'vitest';
import {
  ORG_NAME_LEGAL_SUFFIXES,
  exactOrgMatchKey,
  normalizeOrgMatchName,
  siteNameMatchKey,
} from './orgNameMatch';

describe('normalizeOrgMatchName', () => {
  it.each([
    ['Acme, Inc.', 'acme'],
    ['ACME LLC', 'acme'],
    ['Acme L.L.C.', 'acme'],
    ['Acme Pty. Ltd.', 'acme'],
    ['The Acme Company', 'acme'],
    ['Company Inc', 'company'],
    ['Inc.', 'inc'],
    ['Smith & Jones LLP', 'smith and jones'],
    ['Smith + Jones', 'smith and jones'],
    ["O'Brien Plumbing Ltd", 'obrien plumbing'],
    ['O’Brien Plumbing', 'obrien plumbing'],
    ['Oʼbrien Plumbing', 'obrien plumbing'],
    ['Société Générale SA', 'societe generale'],
    ['Müller GmbH', 'muller'],
    ['İnci Ltd', 'inci'],
    ['Ａｃｍｅ Inc', 'acme'],
    ['  Acme   Dental  ', 'acme dental'],
    ['Acme Holdings Co Ltd', 'acme holdings'],
    ['Acme-Dental/West', 'acme dental west'],
    ['The', 'the'],
    ['Theatre Group Ltd', 'theatre group'],
    ['Pty Ltd', 'pty'],
  ])('normalizeOrgMatchName(%j) === %j', (input, expected) => {
    expect(normalizeOrgMatchName(input)).toBe(expected);
  });

  it.each(['', '   ', '---', null, undefined])('normalizeOrgMatchName(%j) is null', (value) => {
    expect(normalizeOrgMatchName(value)).toBeNull();
  });

  it.each(ORG_NAME_LEGAL_SUFFIXES.map((suffix) => [suffix]))('strips suffix %j', (suffix) => {
    expect(normalizeOrgMatchName(`Acme ${suffix}`)).toBe('acme');
  });

  it('carries every suffix the spec lists', () => {
    expect([...ORG_NAME_LEGAL_SUFFIXES].sort()).toEqual(
      [
        'inc', 'incorporated', 'llc', 'l l c', 'lc', 'ltd', 'limited', 'corp', 'corporation', 'co',
        'company', 'plc', 'pllc', 'pc', 'lp', 'llp', 'gmbh', 'ag', 'kg', 'ug', 'sa', 'sas', 'sarl',
        'srl', 'spa', 'bv', 'nv', 'pty', 'pte', 'oy', 'ab', 'as', 'aps', 'kk', 'pty ltd',
      ].sort(),
    );
  });

  it('keeps distinct customers distinct', () => {
    expect(normalizeOrgMatchName('Acme Dental')).not.toBe(normalizeOrgMatchName('Acme Dentistry'));
  });

  it('strips only one leading "the"', () => {
    expect(normalizeOrgMatchName('The The Band')).toBe('the band');
  });
});

describe('exactOrgMatchKey', () => {
  it('is trim + lowercase only', () => {
    expect(exactOrgMatchKey(' Acme Inc ')).toBe('acme inc');
    expect(exactOrgMatchKey('Acme, Inc.')).toBe('acme, inc.');
    expect(exactOrgMatchKey('  ')).toBeNull();
    expect(exactOrgMatchKey(null)).toBeNull();
    expect(exactOrgMatchKey(undefined)).toBeNull();
  });
});

describe('siteNameMatchKey', () => {
  it('never strips suffixes', () => {
    expect(siteNameMatchKey(' Main  Office LLC ')).toBe('main office llc');
  });

  it('applies NFKC and keeps punctuation', () => {
    expect(siteNameMatchKey('Ｍａｉｎ Office, West')).toBe('main office, west');
  });

  it('is null for blank input', () => {
    expect(siteNameMatchKey('   ')).toBeNull();
    expect(siteNameMatchKey(null)).toBeNull();
  });
});
