import { describe, expect, it } from 'vitest';
import { installerSecretsFromPayload, scrubInstallerSecrets } from './installerSecretScrub';

const FILE_NAME = 'setupdownloader_[aHR0cHM6Ly9leGFtcGxlLnRlc3Q=-synthetic].exe';
const STEM = 'setupdownloader_[aHR0cHM6Ly9leGFtcGxlLnRlc3Q=-synthetic]';
const ENCODED = 'setupdownloader_%5BaHR0cHM6Ly9leGFtcGxlLnRlc3Q%3D-synthetic%5D.exe';
const BARE_URL = `https://download.example.test/Packages/0/${ENCODED}`;
const URL_WITH_QUERY = `${BARE_URL}?token=synthetic-token`;
const secrets = { fileName: FILE_NAME, downloadUrl: URL_WITH_QUERY };

describe('scrubInstallerSecrets', () => {
  it.each([
    ['a Windows exec error with the full path', `fork/exec C:\\Temp\\breeze-1\\${FILE_NAME}: access denied`, 'fork/exec C:\\Temp\\breeze-1\\[installer]: access denied'],
    ['the stem alone', `process ${STEM} exited 5`, 'process [installer] exited 5'],
    ['the URL with its query', `GET ${URL_WITH_QUERY} failed`, 'GET [installer] failed'],
    ['the URL without its query', `GET ${BARE_URL} failed`, 'GET [installer] failed'],
    ['the percent-encoded name', `saved ${ENCODED}`, 'saved [installer]'],
    ['a different case', `C:\\TEMP\\${FILE_NAME.toUpperCase()}`, 'C:\\TEMP\\[installer]'],
    ['every occurrence', `${FILE_NAME} and ${FILE_NAME}`, '[installer] and [installer]'],
  ])('replaces %s', (_label, text, expected) => {
    expect(scrubInstallerSecrets(text, secrets)).toBe(expected);
  });

  it('leaves no fragment of the secret behind', () => {
    const scrubbed = scrubInstallerSecrets(`${URL_WITH_QUERY} ${FILE_NAME} ${STEM}`, secrets);
    for (const fragment of ['aHR0cHM6', 'synthetic-token', 'download.example.test']) {
      expect(scrubbed).not.toContain(fragment);
    }
  });

  it('a stem under 8 characters is too common to replace, but the whole file name still is', () => {
    expect(scrubInstallerSecrets('setup failed: setup.exe', { fileName: 'setup.exe' })).toBe('setup failed: [installer]');
  });

  it.each([
    ['absent secrets', {}],
    ['null secrets', { fileName: null, downloadUrl: null }],
    ['an empty file name', { fileName: '' }],
    ['a URL that does not parse', { downloadUrl: 'not a url' }],
  ])('%s leave the text unchanged', (_label, none) => {
    expect(scrubInstallerSecrets('exit status 1603', none)).toBe('exit status 1603');
  });

  it('treats regex metacharacters in the name literally', () => {
    expect(scrubInstallerSecrets('setupXdownloader.exe', { fileName: 'setup.downloader.exe' })).toBe('setupXdownloader.exe');
  });
});

describe('installerSecretsFromPayload', () => {
  it('returns the secrets for an installer-capable framework provider', () => {
    expect(installerSecretsFromPayload({ integrationProvider: 'bitdefender', fileName: FILE_NAME, downloadUrl: BARE_URL })).toEqual({
      fileName: FILE_NAME, downloadUrl: BARE_URL,
    });
  });

  it.each([
    ['Huntress (no marker on its payload)', { fileName: 'HuntressInstaller.exe', downloadUrl: BARE_URL }],
    ['a provider with no framework installer', { integrationProvider: 'huntress', fileName: 'x.exe' }],
    ['an unrelated command', { path: 'C:\\x' }],
    ['no payload', null],
    ['an array', []],
    ['a string', 'payload'],
  ])('returns null for %s', (_label, payload) => {
    expect(installerSecretsFromPayload(payload)).toBeNull();
  });
});
