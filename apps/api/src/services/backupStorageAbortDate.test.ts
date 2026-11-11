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
import { describe, expect, it } from 'vitest';
import { CreateMultipartUploadCommand, ListPartsCommand, type S3Client } from '@aws-sdk/client-s3';
import { buildS3StorageClient } from './backupSnapshotStorage';
import { dropUnparseableAbortDate } from './guardedS3Client';

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

function storeClient(headers: Record<string, string>, body: string): S3Client {
  const { client } = buildS3StorageClient({
    bucket: 'backups',
    region: 'us-east-1',
    endpoint: 'https://s3.storage.example.test',
    accessKey: 'AKIDEXAMPLE',
    secretKey: 'secret',
  });
  // The SDK reads `config.requestHandler` at send time; swapping it keeps the
  // client's own middleware (including anything buildS3StorageClient adds)
  // and replaces only the network.
  (client.config as { requestHandler: unknown }).requestHandler = {
    handle: async () => ({
      response: {
        statusCode: 200,
        headers: { 'content-type': 'application/xml', ...headers },
        body: Readable.from([Buffer.from(body)]),
      },
    }),
  };
  return client;
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
