/**
 * #11764: an S3-compatible store (Wasabi) answered CreateMultipartUpload with
 * an `x-amz-abort-date` header in Go's `time.Time.String()` form rather than
 * an HTTP-date. The SDK binds that header to `AbortDate` and its RFC 7231
 * parser threw while deserializing an otherwise successful answer, so every
 * multipart backup write failed with a 502 even though the store had created
 * the upload.
 *
 * These tests drive the REAL client `buildS3StorageClient` returns (the one
 * every backup write uses) through the real SDK middleware stack and
 * deserializer. Only the transport is replaced, with a handler that returns a
 * canned HTTP response, so the header reaches the SDK exactly as it would off
 * the wire.
 */
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateMultipartUploadCommand, GetObjectCommand, ListPartsCommand, type S3Client } from '@aws-sdk/client-s3';
import { buildS3StorageClient } from './backupSnapshotStorage';
import {
  __resetAbortDateWarningForTests,
  __setAbortDateBodyCapForTests,
  dropUnparseableAbortDate,
  stripUnparseableAbortDateElements,
} from './guardedS3Client';

// The value from the production log, verbatim.
const GO_TIME_STRING = '2026-11-13 18:06:18.053423249 +0000 UTC m=+754689.983094980';
const HTTP_DATE = 'Fri, 13 Nov 2026 18:06:18 GMT';

const CREATE_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>backups</Bucket><Key>snapshots/s1/data.bin</Key><UploadId>upload-123</UploadId>
</InitiateMultipartUploadResult>`;

const LIST_PARTS_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>backups</Bucket><Key>snapshots/s1/data.bin</Key><UploadId>upload-123</UploadId>
  <IsTruncated>false</IsTruncated>
  <Part><PartNumber>1</PartNumber><ETag>"etag-1"</ETag><Size>5</Size></Part>
</ListPartsResult>`;

interface StoreResponse {
  headers?: Record<string, string>;
  /** The body as it comes off the wire, one Buffer per chunk. */
  chunks: Buffer[];
  statusCode?: number;
}

/** A real backup-store client whose transport answers every request with `res`. `bodies` holds each body stream it handed out. */
function storeClientWith(res: StoreResponse): { client: S3Client; bodies: Readable[] } {
  const { client } = buildS3StorageClient({
    bucket: 'backups',
    region: 'us-east-1',
    endpoint: 'https://s3.storage.example.test',
    accessKey: 'AKIDEXAMPLE',
    secretKey: 'secret',
  });
  const bodies: Readable[] = [];
  // The SDK reads `config.requestHandler` at send time; swapping it keeps the
  // client's own middleware (including anything buildS3StorageClient adds)
  // and replaces only the network.
  (client.config as { requestHandler: unknown }).requestHandler = {
    handle: async () => {
      const body = Readable.from(res.chunks, { objectMode: false });
      bodies.push(body);
      return {
        response: {
          statusCode: res.statusCode ?? 200,
          headers: { 'content-type': 'application/xml', ...res.headers },
          body,
        },
      };
    },
  };
  return { client, bodies };
}

function storeClient(headers: Record<string, string>, body: string): S3Client {
  return storeClientWith({ headers, chunks: [Buffer.from(body)] }).client;
}

describe('backup storage client: x-amz-abort-date the SDK cannot parse (#11764)', () => {
  it('CreateMultipartUpload succeeds and returns the upload id when the store sends a Go time string', async () => {
    const client = storeClient({ 'x-amz-abort-date': GO_TIME_STRING, 'x-amz-abort-rule-id': 'abort-incomplete' }, CREATE_BODY);

    const out = await client.send(new CreateMultipartUploadCommand({ Bucket: 'backups', Key: 'snapshots/s1/data.bin' }));

    expect(out.UploadId).toBe('upload-123');
    expect(out.AbortDate).toBeUndefined();
    // Only the unparseable header is dropped; its sibling is untouched.
    expect(out.AbortRuleId).toBe('abort-incomplete');
  });

  it('ListParts (the other command that binds AbortDate) is covered by the same client', async () => {
    const client = storeClient({ 'x-amz-abort-date': GO_TIME_STRING }, LIST_PARTS_BODY);

    const out = await client.send(new ListPartsCommand({ Bucket: 'backups', Key: 'snapshots/s1/data.bin', UploadId: 'upload-123' }));

    expect(out.Parts?.map((p) => p.PartNumber)).toEqual([1]);
    expect(out.AbortDate).toBeUndefined();
  });

  it('leaves a valid HTTP-date alone: AbortDate still deserializes', async () => {
    const client = storeClient({ 'x-amz-abort-date': HTTP_DATE }, CREATE_BODY);

    const out = await client.send(new CreateMultipartUploadCommand({ Bucket: 'backups', Key: 'snapshots/s1/data.bin' }));

    expect(out.UploadId).toBe('upload-123');
    expect(out.AbortDate?.toISOString()).toBe('2026-11-13T18:06:18.000Z');
  });
});

describe('dropUnparseableAbortDate', () => {
  it('warns once per process when it drops a value, not on every response', () => {
    // Runs first in this block; the integration tests above may already have
    // spent the once-per-process warning, so reset it through the seam.
    __resetAbortDateWarningForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      dropUnparseableAbortDate({ 'x-amz-abort-date': GO_TIME_STRING });
      dropUnparseableAbortDate({ 'x-amz-abort-date': GO_TIME_STRING });
      dropUnparseableAbortDate({ 'x-amz-abort-date': HTTP_DATE });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('x-amz-abort-date');
      expect(JSON.stringify(warn.mock.calls[0])).toContain(GO_TIME_STRING);
    } finally {
      warn.mockRestore();
    }
  });

  it('matches the header name case-insensitively', () => {
    const headers: Record<string, string> = { 'X-Amz-Abort-Date': GO_TIME_STRING, 'X-Amz-Abort-Rule-Id': 'r' };
    dropUnparseableAbortDate(headers);
    expect(headers).toEqual({ 'X-Amz-Abort-Rule-Id': 'r' });
  });

  it('keeps an IMF-fixdate, with or without fractional seconds', () => {
    for (const value of [HTTP_DATE, 'Fri, 13 Nov 2026 18:06:18.123 GMT', 'Tue, 29 Feb 2028 00:00:00 GMT']) {
      const headers: Record<string, string> = { 'x-amz-abort-date': value };
      dropUnparseableAbortDate(headers);
      expect(headers, value).toEqual({ 'x-amz-abort-date': value });
    }
  });

  it('drops anything else: empty, ISO-8601, Go time, out-of-range, impossible day, obsolete forms', () => {
    for (const value of [
      '',
      '2026-11-13T18:06:18Z',
      GO_TIME_STRING,
      'Fri, 13 Nov 2026 25:06:18 GMT',
      'Fri, 31 Nov 2026 18:06:18 GMT',
      'Friday, 13-Nov-26 18:06:18 GMT',
      'Fri Nov 13 18:06:18 2026',
    ]) {
      const headers: Record<string, string> = { 'x-amz-abort-date': value };
      dropUnparseableAbortDate(headers);
      expect(headers, JSON.stringify(value)).toEqual({});
    }
  });
});

/**
 * A store can also put `<AbortDate>` in the XML BODY of CreateMultipartUpload
 * / ListParts, in Go's `time.Time.String()` form, with no header at all. The
 * SDK deserializes every body member, AbortDate included, before it applies
 * header bindings, so stripping only the header never reached this case. The
 * production error message matches this mechanism exactly; the store's raw
 * response has not been captured.
 */
const BODY_GO_TIME_STRING = '2026-11-23 18:17:53.781592214 +0000 UTC m=+1616448.187502702';

function withAbortDateElement(body: string, closingTag: string, value: string): string {
  return body.replace(closingTag, `  <AbortDate>${value}</AbortDate>\n${closingTag}`);
}

describe('backup storage client: <AbortDate> in the response body the SDK cannot parse', () => {
  it('CreateMultipartUpload returns the upload id when the body carries a Go time string and there is no header', async () => {
    const client = storeClient({}, withAbortDateElement(CREATE_BODY, '</InitiateMultipartUploadResult>', BODY_GO_TIME_STRING));

    const out = await client.send(new CreateMultipartUploadCommand({ Bucket: 'backups', Key: 'snapshots/s1/data.bin' }));

    expect(out.UploadId).toBe('upload-123');
    expect(out.Bucket).toBe('backups');
    expect(out.AbortDate).toBeUndefined();
  });

  it('ListParts returns its parts when the body carries a Go time string and there is no header', async () => {
    const client = storeClient({}, withAbortDateElement(LIST_PARTS_BODY, '</ListPartsResult>', BODY_GO_TIME_STRING));

    const out = await client.send(new ListPartsCommand({ Bucket: 'backups', Key: 'snapshots/s1/data.bin', UploadId: 'upload-123' }));

    expect(out.Parts?.map((p) => p.PartNumber)).toEqual([1]);
    expect(out.UploadId).toBe('upload-123');
    expect(out.AbortDate).toBeUndefined();
  });
});

describe('backup storage client: body rewrite is narrow and lossless', () => {
  it('keeps a valid IMF-fixdate <AbortDate> in the body and the call succeeds', async () => {
    __resetAbortDateWarningForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const client = storeClient({}, withAbortDateElement(CREATE_BODY, '</InitiateMultipartUploadResult>', HTTP_DATE));

      const out = await client.send(new CreateMultipartUploadCommand({ Bucket: 'backups', Key: 'snapshots/s1/data.bin' }));

      expect(out.UploadId).toBe('upload-123');
      // Observed SDK behaviour: AbortDate is bound to the header, so a body
      // value is parsed (which is what throws on a bad one) and then
      // discarded. Nothing was removed, so nothing is logged.
      expect(out.AbortDate).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('handles a bad header and a bad body element together', async () => {
    const client = storeClient(
      { 'x-amz-abort-date': GO_TIME_STRING, 'x-amz-abort-rule-id': 'abort-incomplete' },
      withAbortDateElement(CREATE_BODY, '</InitiateMultipartUploadResult>', BODY_GO_TIME_STRING),
    );

    const out = await client.send(new CreateMultipartUploadCommand({ Bucket: 'backups', Key: 'snapshots/s1/data.bin' }));

    expect(out.UploadId).toBe('upload-123');
    expect(out.AbortDate).toBeUndefined();
    expect(out.AbortRuleId).toBe('abort-incomplete');
  });

  it('reassembles a body whose element and multi-byte key characters are split across chunks', async () => {
    const key = 'snapshots/s1/données-€-😀.bin';
    const xml = withAbortDateElement(
      CREATE_BODY.replace('snapshots/s1/data.bin', key),
      '</InitiateMultipartUploadResult>',
      BODY_GO_TIME_STRING,
    );
    const bytes = Buffer.from(xml, 'utf8');
    // Cut inside the 4-byte emoji, inside the opening tag, and inside the value.
    const emojiAt = bytes.indexOf(Buffer.from('😀', 'utf8'));
    const tagAt = bytes.indexOf(Buffer.from('<AbortDate>'));
    const cuts = [emojiAt + 2, tagAt + 4, tagAt + 20];
    const chunks = [0, ...cuts].map((start, i) => bytes.subarray(start, cuts[i] ?? bytes.length));
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    const { client } = storeClientWith({ chunks });

    const out = await client.send(new CreateMultipartUploadCommand({ Bucket: 'backups', Key: key }));

    expect(out.UploadId).toBe('upload-123');
    expect(out.Key).toBe(key);
    expect(out.AbortDate).toBeUndefined();
  });

  it('never buffers a GetObject body: the stream reaches the caller unread', async () => {
    const payload = withAbortDateElement(CREATE_BODY, '</InitiateMultipartUploadResult>', BODY_GO_TIME_STRING);
    const { client, bodies } = storeClientWith({
      headers: { 'content-type': 'application/octet-stream' },
      chunks: [Buffer.from(payload)],
    });

    const out = await client.send(new GetObjectCommand({ Bucket: 'backups', Key: 'snapshots/s1/data.bin' }));

    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.readableDidRead).toBe(false);
    // And the bytes are untouched, AbortDate element included.
    expect(await out.Body!.transformToString()).toBe(payload);
  });

  it('leaves a non-2xx answer alone (no rewrite, no warning)', async () => {
    __resetAbortDateWarningForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { client } = storeClientWith({
        statusCode: 404,
        chunks: [Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>NoSuchUpload</Code><Message>gone</Message><AbortDate>${BODY_GO_TIME_STRING}</AbortDate></Error>`)],
      });

      await expect(
        client.send(new ListPartsCommand({ Bucket: 'backups', Key: 'snapshots/s1/data.bin', UploadId: 'upload-123' })),
      ).rejects.toMatchObject({ name: 'NoSuchUpload' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('AbortDate');
    } finally {
      warn.mockRestore();
    }
  });

  describe('size cap', () => {
    let restoreCap: number | undefined;
    afterEach(() => {
      if (restoreCap !== undefined) __setAbortDateBodyCapForTests(restoreCap);
      restoreCap = undefined;
    });

    it('passes an over-cap body through byte-identical, without rewriting it', async () => {
      restoreCap = __setAbortDateBodyCapForTests(64);
      const key = `snapshots/s1/${'ü'.repeat(200)}.bin`;
      const bytes = Buffer.from(CREATE_BODY.replace('snapshots/s1/data.bin', key), 'utf8');
      // Uneven cuts, one inside a two-byte character, so the cap trips mid-body.
      const chunks = [bytes.subarray(0, 40), bytes.subarray(40, 101), bytes.subarray(101, 333), bytes.subarray(333)];
      const { client } = storeClientWith({ chunks });

      const out = await client.send(new CreateMultipartUploadCommand({ Bucket: 'backups', Key: key }));

      expect(out.UploadId).toBe('upload-123');
      expect(out.Key).toBe(key);
    });

    it('an over-cap body with a bad element is not rewritten (the SDK error surfaces unchanged)', async () => {
      restoreCap = __setAbortDateBodyCapForTests(64);
      const { client } = storeClientWith({
        chunks: [Buffer.from(withAbortDateElement(CREATE_BODY, '</InitiateMultipartUploadResult>', BODY_GO_TIME_STRING))],
      });

      await expect(
        client.send(new CreateMultipartUploadCommand({ Bucket: 'backups', Key: 'snapshots/s1/data.bin' })),
      ).rejects.toThrow(/Invalid RFC7231 date-time value/);
    });

    it('skips buffering when content-length already exceeds the cap', async () => {
      // The real body fits the cap; only the declared length says otherwise,
      // so this fails if the length header is ignored.
      const xml = withAbortDateElement(CREATE_BODY, '</InitiateMultipartUploadResult>', BODY_GO_TIME_STRING);
      restoreCap = __setAbortDateBodyCapForTests(Buffer.byteLength(xml) + 1);
      const { client } = storeClientWith({ headers: { 'content-length': '100000' }, chunks: [Buffer.from(xml)] });

      await expect(
        client.send(new CreateMultipartUploadCommand({ Bucket: 'backups', Key: 'snapshots/s1/data.bin' })),
      ).rejects.toThrow(/Invalid RFC7231 date-time value/);
    });
  });
});

describe('stripUnparseableAbortDateElements', () => {
  it('drops a bad element, keeps everything else byte-for-byte', () => {
    const xml = withAbortDateElement(CREATE_BODY, '</InitiateMultipartUploadResult>', BODY_GO_TIME_STRING);
    const out = stripUnparseableAbortDateElements(xml);
    expect(out.dropped).toEqual([BODY_GO_TIME_STRING]);
    expect(out.xml).toBe(CREATE_BODY.replace('</InitiateMultipartUploadResult>', '  \n</InitiateMultipartUploadResult>'));
  });

  it('keeps an IMF-fixdate, including one padded with whitespace', () => {
    for (const value of [HTTP_DATE, ` ${HTTP_DATE}\n`]) {
      const xml = `<R><AbortDate>${value}</AbortDate></R>`;
      expect(stripUnparseableAbortDateElements(xml)).toEqual({ xml, dropped: [] });
    }
  });

  it('drops empty, self-closing and attributed elements, and every bad one in the document', () => {
    const xml = `<R><AbortDate></AbortDate><AbortDate/><AbortDate x="1">2026-11-23</AbortDate><AbortDate>${HTTP_DATE}</AbortDate></R>`;
    const out = stripUnparseableAbortDateElements(xml);
    expect(out.xml).toBe(`<R><AbortDate>${HTTP_DATE}</AbortDate></R>`);
    expect(out.dropped).toEqual(['', '', '2026-11-23']);
  });

  it('stays linear on a hostile body of unterminated openers (the body comes from a tenant-chosen endpoint)', () => {
    // ~1 MiB of `<AbortDate x` with no `>` anywhere: a pattern whose attribute
    // part can run past the next `<` rescans the rest of the body from every
    // opener (quadratic). Linear matching finishes in milliseconds.
    for (const unit of ['<AbortDate x', '<AbortDate x>a', '<AbortDate   ']) {
      const xml = unit.repeat(Math.ceil((1024 * 1024) / unit.length));
      const started = performance.now();
      const out = stripUnparseableAbortDateElements(xml);
      expect(performance.now() - started, JSON.stringify(unit)).toBeLessThan(1000);
      expect(out.dropped).toEqual([]);
    }
  });

  it('does not touch an element merely named like it, or escaped text', () => {
    const xml = '<R><AbortDateRule>x</AbortDateRule><Key>&lt;AbortDate&gt;x&lt;/AbortDate&gt;</Key></R>';
    expect(stripUnparseableAbortDateElements(xml)).toEqual({ xml, dropped: [] });
  });

  it('warns once per process for the body, naming the source and the command', async () => {
    __resetAbortDateWarningForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const body = withAbortDateElement(CREATE_BODY, '</InitiateMultipartUploadResult>', BODY_GO_TIME_STRING);
      for (let i = 0; i < 2; i++) {
        await storeClient({}, body).send(new CreateMultipartUploadCommand({ Bucket: 'backups', Key: 'snapshots/s1/data.bin' }));
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('body');
      expect(JSON.stringify(warn.mock.calls[0])).toContain(BODY_GO_TIME_STRING);
      expect(JSON.stringify(warn.mock.calls[0])).toContain('CreateMultipartUploadCommand');
    } finally {
      warn.mockRestore();
    }
  });
});
