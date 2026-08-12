import { gunzipSync } from 'node:zlib';

export const MAX_DECODED_BODY_BYTES = 4 * 1024 * 1024;

export class DecodedBodyTooLargeError extends Error {
  constructor() {
    super('Decoded request body exceeds the limit');
    this.name = 'DecodedBodyTooLargeError';
  }
}

export async function readDecodedBody(request: Request): Promise<string> {
  const encoded = Buffer.from(await request.arrayBuffer());
  const isGzip = request.headers.get('content-encoding')?.toLowerCase().includes('gzip') ?? false;

  if (!isGzip) {
    if (encoded.byteLength > MAX_DECODED_BODY_BYTES) throw new DecodedBodyTooLargeError();
    return encoded.toString('utf8');
  }

  try {
    return gunzipSync(encoded, { maxOutputLength: MAX_DECODED_BODY_BYTES }).toString('utf8');
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_BUFFER_TOO_LARGE'
    ) {
      throw new DecodedBodyTooLargeError();
    }
    throw error;
  }
}
