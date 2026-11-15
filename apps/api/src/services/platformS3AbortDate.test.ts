/**
 * #11782 (follow-up to #11764): the platform, env-configured S3 clients
 * (`s3Storage.ts`, `artifacts/blobStorage.ts`) must tolerate an
 * `x-amz-abort-date` the SDK cannot parse, exactly like the customer-store
 * client. Each test drives the REAL client its module builds through the real
 * SDK middleware stack; only the transport is replaced.
 */
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateMultipartUploadCommand, ListPartsCommand, type S3Client } from '@aws-sdk/client-s3';
import { __getS3ClientForTests, __resetS3ClientForTests } from './s3Storage';
import { blobClientForTests, resetBlobClientsForTests } from './artifacts/blobStorage';

const GO_TIME_STRING = '2026-11-13 18:06:18.053423249 +0000 UTC m=+754689.983094980';
const HTTP_DATE = 'Fri, 13 Nov 2026 18:06:18 GMT';

const CREATE_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>b</Bucket><Key>k</Key><UploadId>upload-123</UploadId>
</InitiateMultipartUploadResult>`;
const LIST_PARTS_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>b</Bucket><Key>k</Key><UploadId>upload-123</UploadId><IsTruncated>false</IsTruncated>
  <Part><PartNumber>1</PartNumber><ETag>"e"</ETag><Size>5</Size></Part>
</ListPartsResult>`;

function withTransport(client: S3Client, headers: Record<string, string>, body: string): S3Client {
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

const ENV_KEYS = ['S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.S3_ACCESS_KEY = 'AKIDEXAMPLE';
  process.env.S3_SECRET_KEY = 'secret';
  process.env.S3_ENDPOINT = 'https://s3.storage.example.test';
  process.env.S3_BUCKET = 'b';
  __resetS3ClientForTests();
  resetBlobClientsForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetS3ClientForTests();
  resetBlobClientsForTests();
});

const clients: Array<[string, () => S3Client]> = [
  ['s3Storage', () => __getS3ClientForTests()],
  ['artifacts blobStorage', () => blobClientForTests('us')],
];

describe.each(clients)('%s client: x-amz-abort-date the SDK cannot parse (#11782)', (_name, build) => {
  it('CreateMultipartUpload succeeds when the store sends a Go time string', async () => {
    const client = withTransport(build(), { 'x-amz-abort-date': GO_TIME_STRING, 'x-amz-abort-rule-id': 'r' }, CREATE_BODY);
    const out = await client.send(new CreateMultipartUploadCommand({ Bucket: 'b', Key: 'k' }));
    expect(out.UploadId).toBe('upload-123');
    expect(out.AbortDate).toBeUndefined();
    expect(out.AbortRuleId).toBe('r');
  });

  it('ListParts is covered too', async () => {
    const client = withTransport(build(), { 'x-amz-abort-date': GO_TIME_STRING }, LIST_PARTS_BODY);
    const out = await client.send(new ListPartsCommand({ Bucket: 'b', Key: 'k', UploadId: 'upload-123' }));
    expect(out.Parts?.map((p) => p.PartNumber)).toEqual([1]);
    expect(out.AbortDate).toBeUndefined();
  });

  it('leaves a valid HTTP-date alone', async () => {
    const client = withTransport(build(), { 'x-amz-abort-date': HTTP_DATE }, CREATE_BODY);
    const out = await client.send(new CreateMultipartUploadCommand({ Bucket: 'b', Key: 'k' }));
    expect(out.AbortDate?.toISOString()).toBe('2026-11-13T18:06:18.000Z');
  });
});
