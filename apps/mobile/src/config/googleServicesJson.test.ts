import { describe, expect, it } from 'vitest';

import {
  EXPECTED_ANDROID_PACKAGE,
  GoogleServicesJsonError,
  parseGoogleServicesJson,
} from './googleServicesJson';

const validPayload = {
  project_info: { project_id: 'breeze-rmm', project_number: '123' },
  client: [
    {
      client_info: {
        mobilesdk_app_id: '1:123:android:abc',
        android_client_info: { package_name: EXPECTED_ANDROID_PACKAGE },
      },
      api_key: [{ current_key: 'abc' }],
    },
  ],
};

describe('parseGoogleServicesJson', () => {
  it('rejects an unset/empty secret', () => {
    expect(() => parseGoogleServicesJson(undefined)).toThrow(GoogleServicesJsonError);
    expect(() => parseGoogleServicesJson('')).toThrow(/not set/);
  });

  it('accepts raw JSON matching the google-services.json shape, unchanged', () => {
    const raw = JSON.stringify(validPayload);
    expect(parseGoogleServicesJson(raw)).toBe(raw);
  });

  it('accepts base64-encoded JSON, decoded', () => {
    const decoded = JSON.stringify(validPayload);
    const encoded = Buffer.from(decoded, 'utf8').toString('base64');
    expect(parseGoogleServicesJson(encoded)).toBe(decoded);
  });

  it('rejects a value that is neither valid JSON nor base64-encoded JSON', () => {
    expect(() => parseGoogleServicesJson('not json, not base64 {{{')).toThrow(
      /neither valid JSON nor base64/
    );
  });

  it('rejects valid JSON that is not an object (the "is it JSON" trap)', () => {
    for (const notAnObject of ['true', '"a string"', '42', '[1,2,3]']) {
      expect(() => parseGoogleServicesJson(notAnObject)).toThrow(/not a JSON object/);
    }
  });

  it('rejects JSON missing project_info.project_id (e.g. a pasted FIREBASE_SERVICE_ACCOUNT)', () => {
    const wrongSecret = JSON.stringify({ private_key: 'x', client_email: 'y' });
    expect(() => parseGoogleServicesJson(wrongSecret)).toThrow(/project_info\.project_id/);
  });

  it('rejects JSON with no client[] entries', () => {
    const noClients = JSON.stringify({ project_info: { project_id: 'p' }, client: [] });
    expect(() => parseGoogleServicesJson(noClients)).toThrow(/no client/);
  });

  it('rejects a google-services.json for the wrong Android package', () => {
    const wrongPackage = JSON.stringify({
      project_info: { project_id: 'p' },
      client: [
        {
          client_info: { android_client_info: { package_name: 'com.someone.else' } },
        },
      ],
    });
    expect(() => parseGoogleServicesJson(wrongPackage)).toThrow(/com\.someone\.else/);
  });

  it('accepts a client entry with no android_client_info at all (iOS-only client in the same file)', () => {
    const raw = JSON.stringify({
      project_info: { project_id: 'p' },
      client: [{ client_info: { mobilesdk_app_id: '1:1:ios:abc' } }],
    });
    expect(parseGoogleServicesJson(raw)).toBe(raw);
  });
});
