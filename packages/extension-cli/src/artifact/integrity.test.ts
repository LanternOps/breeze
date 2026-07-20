import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildIntegrityDocument, signingPayload } from './integrity';

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('buildIntegrityDocument', () => {
  it('produces a strict {algorithm, members} document with sha256 + size per member', () => {
    const fileA = Buffer.from('hello world');
    const fileB = Buffer.from('{}');
    const bytes = buildIntegrityDocument([
      { path: 'server/index.js', bytes: fileA },
      { path: 'manifest.json', bytes: fileB },
    ]);

    const parsed = JSON.parse(bytes.toString('utf8'));
    expect(parsed).toEqual({
      algorithm: 'sha256',
      members: {
        'server/index.js': { sha256: sha256Hex(fileA), size: fileA.length },
        'manifest.json': { sha256: sha256Hex(fileB), size: fileB.length },
      },
    });
  });

  it('emits bare lowercase hex digests', () => {
    const bytes = buildIntegrityDocument([{ path: 'a.txt', bytes: Buffer.from('x') }]);
    const parsed = JSON.parse(bytes.toString('utf8'));
    expect(parsed.members['a.txt'].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('emits keys in sorted order, deterministic regardless of input order', () => {
    const inOrder = buildIntegrityDocument([
      { path: 'b.txt', bytes: Buffer.from('b') },
      { path: 'a.txt', bytes: Buffer.from('a') },
    ]);
    const reordered = buildIntegrityDocument([
      { path: 'a.txt', bytes: Buffer.from('a') },
      { path: 'b.txt', bytes: Buffer.from('b') },
    ]);
    expect(inOrder.toString('utf8')).toBe(reordered.toString('utf8'));
    expect(inOrder.toString('utf8')).toBe(
      '{"algorithm":"sha256","members":{"a.txt":{"sha256":"'
      + sha256Hex(Buffer.from('a'))
      + '","size":1},"b.txt":{"sha256":"'
      + sha256Hex(Buffer.from('b'))
      + '","size":1}}}',
    );
  });

  it('emits no whitespace (canonical JSON bytes)', () => {
    const bytes = buildIntegrityDocument([{ path: 'a.txt', bytes: Buffer.from('a') }]);
    expect(bytes.toString('utf8')).not.toMatch(/\s/);
  });

  it('throws when a path is the reserved member "integrity.json"', () => {
    expect(() => buildIntegrityDocument([{ path: 'integrity.json', bytes: Buffer.from('x') }])).toThrow();
  });

  it('throws when a path is the reserved member "signature"', () => {
    expect(() => buildIntegrityDocument([{ path: 'signature', bytes: Buffer.from('x') }])).toThrow();
  });

  it('throws on a duplicate path', () => {
    expect(() => buildIntegrityDocument([
      { path: 'a.txt', bytes: Buffer.from('a') },
      { path: 'a.txt', bytes: Buffer.from('b') },
    ])).toThrow();
  });

  it('returns an empty members map for an empty member list', () => {
    const bytes = buildIntegrityDocument([]);
    expect(JSON.parse(bytes.toString('utf8'))).toEqual({ algorithm: 'sha256', members: {} });
  });
});

describe('signingPayload', () => {
  const manifest = { apiVersion: 'breeze.extensions/v1', name: 'acme-widgets', version: '1.2.3' } as const;

  it('is a UTF-8 buffer of exactly five canonical fields with bare hex hashes', () => {
    const manifestBytes = Buffer.from('manifest-bytes');
    const integrityBytes = Buffer.from('integrity-bytes');
    const payload = signingPayload(manifest, manifestBytes, integrityBytes);
    const parsed = JSON.parse(payload.toString('utf8'));

    expect(Object.keys(parsed).sort()).toEqual([
      'apiVersion', 'integritySha256', 'manifestSha256', 'name', 'version',
    ]);
    expect(parsed.apiVersion).toBe(manifest.apiVersion);
    expect(parsed.name).toBe(manifest.name);
    expect(parsed.version).toBe(manifest.version);
    expect(parsed.manifestSha256).toBe(sha256Hex(manifestBytes));
    expect(parsed.integritySha256).toBe(sha256Hex(integrityBytes));
    expect(parsed.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.integritySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('emits no whitespace', () => {
    const payload = signingPayload(manifest, Buffer.from('m'), Buffer.from('i'));
    expect(payload.toString('utf8')).not.toMatch(/\s/);
  });

  // Drift guard: hard-coded golden bytes produced by feeding this exact
  // fixture into the REAL `canonicalSigningPayload` export from
  // apps/api/src/extensions/bundleVerifier.ts, via a one-off scratch script
  // (not committed). This package must not import apps/api, so the live
  // cross-check against the real export happens in Task 6's conformance
  // test; this test locks our independent implementation to that captured
  // golden value in the meantime.
  it('matches the golden vector captured from the real bundleVerifier export', () => {
    const goldenManifest = {
      apiVersion: 'breeze.extensions/v1',
      name: 'acme-widgets',
      version: '1.2.3',
    } as const;
    const manifestBytes = Buffer.from(
      '7b2268656c6c6f223a226d616e6966657374222c226e223a317d',
      'hex',
    );
    const integrityBytes = Buffer.from(
      '7b22616c676f726974686d223a22736861323536222c226d656d62657273223a7b7d7d',
      'hex',
    );

    const payload = signingPayload(goldenManifest, manifestBytes, integrityBytes);

    const goldenHex = '7b2261706956657273696f6e223a22627265657a652e657874656e73696f6e732f7631222c22696e74656772697479536861323536223a2233313538316636333035656264356632666630346439646363646437333865393865616464396464646264623066336366306234336236613432373162633562222c226d616e6966657374536861323536223a2262373161663963383337353962336636333538313931393736616331346330376566376532363864666339613331393265353362373337333337323563623764222c226e616d65223a2261636d652d77696467657473222c2276657273696f6e223a22312e322e33227d';

    expect(payload.toString('hex')).toBe(goldenHex);
    expect(payload.toString('utf8')).toBe(
      '{"apiVersion":"breeze.extensions/v1","integritySha256":"31581f6305ebd5f2ff04d9dccdd738e98eadd9dddbdb0f3cf0b43b6a4271bc5b","manifestSha256":"b71af9c83759b3f6358191976ac14c07ef7e268dfc9a3192e53b73733725cb7d","name":"acme-widgets","version":"1.2.3"}',
    );
  });
});
