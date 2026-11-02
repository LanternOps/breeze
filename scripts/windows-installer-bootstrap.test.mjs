import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildInstallCommands } from '../apps/web/src/lib/installCommands.ts';
import { generateWindowsInstallScript } from '../apps/api/src/services/windowsInstallScript.ts';

const powershell = process.env.BREEZE_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
const fixture = Buffer.from(`function Install-BreezeAgent {
  param([string]$Token, [string]$EnrollmentSecret)
  @{token=$Token; secret=$EnrollmentSecret; message='verified café'} | ConvertTo-Json -Compress
}
`, 'utf8');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const literal = (value) => `'${value.replaceAll("'", "''")}'`;

async function runBootstrap({ bytes = fixture, sha256 = digest(fixture), status = 200, token = 'test-token', secret = '', url = 'https://rmm.example.test/api/v1/agents/install.ps1', live = false, setup = '' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'breeze-bootstrap-test-'));
  const path = join(directory, 'bootstrap.ps1');
  const command = buildInstallCommands({
    apiUrl: 'https://dashboard.example.test', token, enrollmentSecret: secret,
    windowsInstaller: { url, sha256 },
  }).windows;
  assert.equal(typeof command, 'string');
  const mock = `function Invoke-WebRequest {
    [CmdletBinding()]
    param([string]$Uri, [switch]$UseBasicParsing, [int]$TimeoutSec, [int]$MaximumRedirection, [string]$UserAgent, [hashtable]$Headers)
    if ($Uri -ne ${literal(url)} -or !$UseBasicParsing -or $TimeoutSec -ne 10 -or $MaximumRedirection -ne 0 -or $UserAgent -ne 'BreezeInstaller/1.0') { throw 'Invalid download arguments' }
    if ($Headers.Count -ne 1 -or $Headers['Accept-Encoding'] -ne 'identity') { throw 'Unexpected request headers' }
    $stream = [IO.MemoryStream]::new([Convert]::FromBase64String('${bytes.toString('base64')}'))
    $stream.Position = $stream.Length
    [pscustomobject]@{StatusCode=${status}; RawContentStream=$stream; Content='Write-Output "UNVERIFIED CONTENT EXECUTED"'}
  }`;
  const source = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:TEMP = ${literal(directory)}
function Install-BreezeAgent { Write-Output 'STALE FUNCTION EXECUTED' }
${live ? '' : mock}
${setup}
${command}
`;
  try {
    await writeFile(path, '\uFEFF' + source, 'utf8');
    return await new Promise((resolve, reject) => {
      execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path], { timeout: 25_000, encoding: 'utf8', env: environment }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') reject(error);
        else resolve({ code: error?.code ?? 0, stdout, stderr });
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertRejected(result) {
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /EXECUTED|verified café/);
}

test('verified raw UTF-8 bytes execute once with literal enrollment arguments', async () => {
  const token = "token'$(Write-Output INJECTED)`";
  const secret = "secret'\"$env:USERNAME`";
  const result = await runBootstrap({ token, secret });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { token, secret, message: 'verified café' });
});

test('generated installer retrieves metadata and a pinned binary through browser interstitials', async () => {
  const binary = Buffer.from('MZ-test-agent');
  const requests = [];
  let bytes;
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    if (request.headers['user-agent'] !== 'BreezeInstaller/1.0') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>browser interstitial</title>');
    } else if (request.url === '/api/v1/agents/install.ps1') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(bytes);
    } else if (request.url === '/api/v1/agent-versions/latest?platform=windows&arch=amd64&component=agent') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ version: '1.2.3', checksum: digest(binary) }));
    } else if (request.url === '/api/v1/agents/download/windows/amd64?version=1.2.3') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end(binary);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    let source = generateWindowsInstallScript(url);
    const nativeOperations = [
      ['$osv = [System.Environment]::OSVersion.Version', "$osv = [Version]'10.0'"],
      ['$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value', "$sid = 'S-1-5-18'"],
      ['& $exe @enrollArgs', "Write-Output ('ENROLL=' + (ConvertTo-Json -Compress -InputObject $enrollArgs)); $LASTEXITCODE = 0"],
      ['& $exe service install', "Write-Output 'SERVICE_INSTALL'; $LASTEXITCODE = 0"],
    ];
    for (const [original, replacement] of nativeOperations) {
      assert.equal(source.split(original).length, 2, `Expected one native operation: ${original}`);
      source = source.replace(original, () => replacement);
    }
    bytes = Buffer.from(source, 'utf8');
    const result = await runBootstrap({
      url: `${url}/api/v1/agents/install.ps1`, sha256: digest(bytes), live: true, secret: 'test-secret',
      setup: "function icacls { $global:LASTEXITCODE = 0 }\nfunction Get-AuthenticodeSignature { [pscustomobject]@{Status='NotSigned'} }",
    });
    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.deepEqual(JSON.parse(lines[0].slice('ENROLL='.length)), ['enroll', 'test-token', '--server', url, '--enrollment-secret', 'test-secret']);
    assert.equal(lines[1], 'SERVICE_INSTALL');
    assert.equal(lines.length, 2);
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.headers['user-agent'], 'BreezeInstaller/1.0');
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
      assert.doesNotMatch(request.url, /test-token|test-secret/);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

for (const codePoint of [0x2018, 0x2019, 0x201a, 0x201b]) {
  test(`PowerShell delimiter U+${codePoint.toString(16)} stays literal in enrollment secrets`, async () => {
    const quote = String.fromCodePoint(codePoint);
    const secret = `allowed-secret-32-characters-long${quote}; Write-Output UNINTENDED_CODE_EXECUTED; ${quote}rest`;
    const result = await runBootstrap({ secret });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { token: 'test-token', secret, message: 'verified café' });
  });
}

test('a substituted function prefix never executes', async () => {
  const bytes = Buffer.from('function Install-BreezeAgent {}\nWrite-Output "TAMPERED SCRIPT EXECUTED"');
  const result = await runBootstrap({ bytes });
  assertRejected(result);
  assert.match(result.stderr, /installer checksum mismatch/);
});

test('an appended function cannot capture the enrollment arguments', async () => {
  assertRejected(await runBootstrap({ bytes: Buffer.concat([fixture, Buffer.from('\nfunction Install-BreezeAgent { Write-Output "TAMPERED FUNCTION EXECUTED" }')]) }));
});

test('changing line endings rejects even otherwise equivalent code', async () => {
  assertRejected(await runBootstrap({ bytes: Buffer.from(fixture.toString('utf8').replaceAll('\n', '\r\n')) }));
});

for (const status of [204, 206, 302, 304]) {
  test(`HTTP ${status} cannot execute even matching bytes`, async () => {
    assertRejected(await runBootstrap({ status }));
  });
}

test('a pinned syntax error cannot invoke a stale installer function', async () => {
  const bytes = Buffer.from('function Install-BreezeAgent {');
  assertRejected(await runBootstrap({ bytes, sha256: digest(bytes) }));
});

test('pinned invalid UTF-8 cannot execute', async () => {
  const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
  assertRejected(await runBootstrap({ bytes, sha256: digest(bytes) }));
});

test('missing integrity metadata produces no Windows command', () => {
  assert.equal(buildInstallCommands({ apiUrl: 'https://rmm.example.test', token: 'token', windowsInstaller: null }).windows, null);
});

test('real Invoke-WebRequest receives the exact bytes and never follows redirects', async () => {
  let redirectedRequests = 0;
  let receivedHeaders;
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: `${url}/target` });
      response.end();
    } else if (request.url === '/target') {
      redirectedRequests += 1;
      response.end(fixture);
    } else {
      receivedHeaders = request.headers;
      const scriptRequest = request.headers['user-agent'] === 'BreezeInstaller/1.0';
      response.writeHead(200, { 'Content-Type': scriptRequest ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8' });
      response.end(scriptRequest ? fixture : '<!doctype html><title>browser fallback</title>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const success = await runBootstrap({ url: `${url}/api/v1/agents/install.ps1`, live: true });
    assert.equal(success.code, 0, success.stderr);
    assert.equal(JSON.parse(success.stdout).message, 'verified café');
    assert.equal(receivedHeaders['user-agent'], 'BreezeInstaller/1.0');
    assert.match(receivedHeaders['accept-encoding'], /(?:^|,)\s*identity(?:,|$)/);
    assert.equal(receivedHeaders.authorization, undefined);
    assert.equal(receivedHeaders.cookie, undefined);
    assertRejected(await runBootstrap({ url: `${url}/redirect`, live: true }));
    assert.equal(redirectedRequests, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
