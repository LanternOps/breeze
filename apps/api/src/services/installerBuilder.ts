const PLACEHOLDER_CHAR_LENGTH = 512;

/** Sentinel strings padded to 512 chars with null bytes -- must match build-msi.ps1 */
export const PLACEHOLDERS = {
  SERVER_URL: '@@BREEZE_SERVER_URL@@'.padEnd(PLACEHOLDER_CHAR_LENGTH, '\0'),
  ENROLLMENT_KEY: '@@BREEZE_ENROLLMENT_KEY@@'.padEnd(PLACEHOLDER_CHAR_LENGTH, '\0'),
  ENROLLMENT_SECRET: '@@BREEZE_ENROLLMENT_SECRET@@'.padEnd(PLACEHOLDER_CHAR_LENGTH, '\0'),
};

interface InstallerValues {
  serverUrl: string;
  enrollmentKey: string;
  enrollmentSecret: string;
}

/**
 * Replace UTF-16LE encoded placeholder sentinels in an MSI buffer with real values.
 * Returns a new buffer of the same size (values are null-padded to match placeholder length).
 */
export function replaceMsiPlaceholders(template: Buffer, values: InstallerValues): Buffer {
  const result = Buffer.from(template); // copy

  const replacements: Array<{ name: string; sentinel: string; value: string }> = [
    { name: 'SERVER_URL', sentinel: PLACEHOLDERS.SERVER_URL, value: values.serverUrl },
    { name: 'ENROLLMENT_KEY', sentinel: PLACEHOLDERS.ENROLLMENT_KEY, value: values.enrollmentKey },
    { name: 'ENROLLMENT_SECRET', sentinel: PLACEHOLDERS.ENROLLMENT_SECRET, value: values.enrollmentSecret },
  ];

  for (const { name, sentinel, value } of replacements) {
    if (value.length > PLACEHOLDER_CHAR_LENGTH) {
      throw new Error(`${name} value too long: ${value.length} chars exceeds ${PLACEHOLDER_CHAR_LENGTH} limit`);
    }

    const sentinelBuf = Buffer.from(sentinel, 'utf16le');
    const offset = result.indexOf(sentinelBuf);

    if (offset === -1) {
      throw new Error(`${name} placeholder not found in template MSI`);
    }

    const replacementPadded = value.padEnd(PLACEHOLDER_CHAR_LENGTH, '\0');
    const replacementBuf = Buffer.from(replacementPadded, 'utf16le');

    replacementBuf.copy(result, offset);
  }

  return result;
}
