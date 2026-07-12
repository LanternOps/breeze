export function canonicalizeSingleEndpointPostgresUrl(
  connectionUrl: string,
  errorMessage: string,
): string {
  try {
    if (connectionUrl.includes('#')) throw new Error();

    const authority = connectionUrl.match(
      /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu,
    )?.[1];
    if (authority === undefined) throw new Error();

    const rawAtDelimiterCount = authority.match(/@/gu)?.length ?? 0;
    if (rawAtDelimiterCount > 1) throw new Error();

    const hostSegment = authority.slice(authority.indexOf('@') + 1);
    if (/,|%2c/iu.test(hostSegment)) throw new Error();

    const decodedHostSegment = decodeURIComponent(hostSegment);
    if (/,|%2c/iu.test(decodedHostSegment)) throw new Error();

    const parsed = new URL(connectionUrl);
    if (
      (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
      || !parsed.hostname
    ) {
      throw new Error();
    }

    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);

    return parsed.toString();
  } catch {
    throw new Error(errorMessage);
  }
}
