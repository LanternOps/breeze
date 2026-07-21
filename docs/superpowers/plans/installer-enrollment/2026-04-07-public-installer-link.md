# Public Installer Link & AddDeviceModal Tests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public download endpoint + "Generate Link" button to AddDeviceModal so users can share installer URLs, and add comprehensive tests for the modal.

**Architecture:** A new unauthenticated `publicEnrollmentRoutes` Hono router serves installers using the enrollment key token as auth. The authenticated `POST /:id/installer-link` creates a child key and returns the public URL. The modal adds a "Generate Link" button with copy-to-clipboard.

**Tech Stack:** Hono, Drizzle ORM, Vitest, @testing-library/react, Zustand

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/api/src/routes/enrollmentKeys.ts` | Modify | Add `publicEnrollmentRoutes` (public download) and `POST /:id/installer-link` (generate link) |
| `apps/api/src/index.ts` | Modify | Import and mount `publicEnrollmentRoutes` |
| `apps/web/src/components/devices/AddDeviceModal.tsx` | Modify | Add Generate Link button, link display, copy |
| `apps/web/src/components/devices/AddDeviceModal.test.tsx` | Create | Component tests |

---

### Task 1: Add `POST /:id/installer-link` endpoint

**Files:**
- Modify: `apps/api/src/routes/enrollmentKeys.ts:127-134` (add schema), `:604` (add endpoint after existing installer route)

- [ ] **Step 1: Add the Zod schema for the link request body**

In `apps/api/src/routes/enrollmentKeys.ts`, add this schema after `installerQuerySchema` (line 129):

```typescript
const installerLinkSchema = z.object({
  platform: z.enum(['windows', 'macos']),
  count: z.number().int().min(1).max(100000).optional(),
});
```

- [ ] **Step 2: Add the `POST /:id/installer-link` route**

In `apps/api/src/routes/enrollmentKeys.ts`, add this route after the existing `GET /:id/installer/:platform` route (after line 604):

```typescript
// ============================================
// POST /:id/installer-link - Generate a public download link
// ============================================

enrollmentKeyRoutes.post(
  '/:id/installer-link',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', installerLinkSchema),
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id')!;
    const { platform, count: childMaxUsage = 1 } = c.req.valid('json');

    // Look up parent enrollment key
    const [parentKey] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);

    if (!parentKey) {
      return c.json({ error: 'Enrollment key not found' }, 404);
    }

    // Verify org access
    const hasAccess = await ensureOrgAccess(parentKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Verify key is still usable
    if (parentKey.expiresAt && new Date(parentKey.expiresAt) < new Date()) {
      return c.json({ error: 'Enrollment key has expired' }, 410);
    }
    if (parentKey.maxUsage !== null && parentKey.usageCount >= parentKey.maxUsage) {
      return c.json({ error: 'Enrollment key usage exhausted' }, 410);
    }

    // Require siteId on the parent key
    if (!parentKey.siteId) {
      return c.json({ error: 'Enrollment key must have a siteId to generate installer links' }, 400);
    }

    // Verify template binary is available (fail fast before creating child key)
    try {
      platform === 'windows' ? await fetchTemplateMsi() : await fetchMacosPkg();
    } catch (err) {
      console.error(`[installer-link] Failed to fetch ${platform} binary:`, err);
      return c.json({ error: `${platform === 'windows' ? 'Template MSI' : 'macOS PKG'} not available` }, 503);
    }

    // Generate a child enrollment key
    const rawChildKey = generateEnrollmentKey();
    const childKeyHash = hashEnrollmentKey(rawChildKey);

    const [childKey] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: parentKey.orgId,
        siteId: parentKey.siteId,
        name: `${parentKey.name} (link${childMaxUsage > 1 ? ` x${childMaxUsage}` : ''})`,
        key: childKeyHash,
        keySecretHash: parentKey.keySecretHash,
        maxUsage: childMaxUsage,
        expiresAt: parentKey.expiresAt,
        createdBy: auth.user.id,
      })
      .returning();

    if (!childKey) {
      return c.json({ error: 'Failed to generate installer link' }, 500);
    }

    // Build public URL
    const serverUrl = process.env.PUBLIC_API_URL || process.env.API_URL;
    if (!serverUrl) {
      return c.json({ error: 'Server URL not configured (set PUBLIC_API_URL or API_URL)' }, 500);
    }

    const publicUrl = `${serverUrl.replace(/\/$/, '')}/api/v1/enrollment-keys/public-download/${platform}?token=${rawChildKey}`;

    // Audit log
    writeEnrollmentKeyAudit(c, auth, {
      orgId: parentKey.orgId,
      action: 'enrollment_key.installer_link_created',
      keyId: parentKey.id,
      keyName: parentKey.name,
      details: { platform, childKeyId: childKey.id, count: childMaxUsage },
    });

    return c.json({
      url: publicUrl,
      expiresAt: childKey.expiresAt,
      maxUsage: childMaxUsage,
      platform,
      childKeyId: childKey.id,
    });
  }
);
```

- [ ] **Step 3: Verify the API compiles**

Run: `cd /Users/toddhebebrand/breeze && npx tsc --noEmit --project apps/api/tsconfig.json 2>&1 | grep -i enrollmentKey || echo "No new errors"`

Expected: No new errors related to enrollmentKeys.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/enrollmentKeys.ts
git commit -m "feat(api): add POST /enrollment-keys/:id/installer-link endpoint"
```

---

### Task 2: Add public download endpoint and mount it

**Files:**
- Modify: `apps/api/src/routes/enrollmentKeys.ts:17` (add export)
- Modify: `apps/api/src/index.ts:666` (add mount)

- [ ] **Step 1: Add `publicEnrollmentRoutes` to `enrollmentKeys.ts`**

At the end of `apps/api/src/routes/enrollmentKeys.ts` (after the last route), add:

```typescript
// ============================================
// Public routes (no auth middleware)
// ============================================

export const publicEnrollmentRoutes = new Hono();

const publicDownloadQuerySchema = z.object({
  token: z.string().min(1),
});

publicEnrollmentRoutes.get(
  '/public-download/:platform',
  zValidator('query', publicDownloadQuerySchema),
  async (c) => {
    const platform = c.req.param('platform');
    const { token } = c.req.valid('query');

    if (platform !== 'windows' && platform !== 'macos') {
      return c.json({ error: 'Invalid platform. Must be "windows" or "macos".' }, 400);
    }

    // Rate limit by IP (10 per minute)
    const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown';
    try {
      const redis = (await import('../services')).getRedis();
      const { rateLimiter: rl } = await import('../services/rate-limit');
      const rateResult = await rl(redis, `public-installer:${ip}`, 10, 60);
      if (!rateResult.allowed) {
        return c.json({ error: 'Too many requests. Please try again later.' }, 429);
      }
    } catch {
      // If Redis is unavailable, allow the request (fail open for downloads)
    }

    // Look up enrollment key by token hash
    const keyHash = hashEnrollmentKey(token);
    const [enrollmentKey] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.key, keyHash))
      .limit(1);

    if (!enrollmentKey) {
      return c.json({ error: 'Invalid or expired download link' }, 404);
    }

    // Validate key is still usable
    if (enrollmentKey.expiresAt && new Date(enrollmentKey.expiresAt) < new Date()) {
      return c.json({ error: 'This download link has expired' }, 410);
    }
    if (enrollmentKey.maxUsage !== null && enrollmentKey.usageCount >= enrollmentKey.maxUsage) {
      return c.json({ error: 'This download link has been used the maximum number of times' }, 410);
    }
    if (!enrollmentKey.siteId) {
      return c.json({ error: 'Invalid enrollment key configuration' }, 400);
    }

    // Determine server URL
    const serverUrl = process.env.PUBLIC_API_URL || process.env.API_URL;
    if (!serverUrl) {
      return c.json({ error: 'Server URL not configured' }, 500);
    }

    const globalSecret = process.env.AGENT_ENROLLMENT_SECRET || '';

    // Fetch template binary
    let templateBuffer: Buffer;
    try {
      templateBuffer = platform === 'windows'
        ? await fetchTemplateMsi()
        : await fetchMacosPkg();
    } catch (err) {
      console.error(`[public-download] Failed to fetch ${platform} binary:`, err);
      return c.json({ error: 'Installer binary not available' }, 503);
    }

    // Increment usage count
    await db
      .update(enrollmentKeys)
      .set({ usageCount: sql`${enrollmentKeys.usageCount} + 1` })
      .where(eq(enrollmentKeys.id, enrollmentKey.id));

    // Build installer
    try {
      if (platform === 'windows') {
        const modified = replaceMsiPlaceholders(templateBuffer, {
          serverUrl,
          enrollmentKey: token,
          enrollmentSecret: globalSecret,
        });

        createAuditLogAsync({
          orgId: enrollmentKey.orgId,
          actorId: 'public',
          action: 'enrollment_key.public_download',
          resourceType: 'enrollment_key',
          resourceId: enrollmentKey.id,
          resourceName: enrollmentKey.name,
          details: { platform, ip },
          ipAddress: ip,
          userAgent: c.req.header('user-agent'),
          result: 'success',
        });

        c.header('Content-Type', 'application/octet-stream');
        c.header('Content-Disposition', 'attachment; filename="breeze-agent.msi"');
        c.header('Content-Length', String(modified.length));
        c.header('Cache-Control', 'no-store');
        return c.body(modified as unknown as ArrayBuffer);
      }

      // macOS
      const zipBuffer = await buildMacosInstallerZip(templateBuffer, {
        serverUrl,
        enrollmentKey: token,
        enrollmentSecret: globalSecret,
        siteId: enrollmentKey.siteId,
      });

      createAuditLogAsync({
        orgId: enrollmentKey.orgId,
        actorId: 'public',
        action: 'enrollment_key.public_download',
        resourceType: 'enrollment_key',
        resourceId: enrollmentKey.id,
        resourceName: enrollmentKey.name,
        details: { platform, ip },
        ipAddress: ip,
        userAgent: c.req.header('user-agent'),
        result: 'success',
      });

      c.header('Content-Type', 'application/zip');
      c.header('Content-Disposition', 'attachment; filename="breeze-agent-macos.zip"');
      c.header('Content-Length', String(zipBuffer.length));
      c.header('Cache-Control', 'no-store');
      return c.body(zipBuffer as unknown as ArrayBuffer);
    } catch (err) {
      console.error('[public-download] Build failed:', err instanceof Error ? err.message : err);
      return c.json({ error: 'Failed to build installer' }, 500);
    }
  }
);
```

- [ ] **Step 2: Mount `publicEnrollmentRoutes` in `index.ts`**

In `apps/api/src/index.ts`, add the import. Find the existing import for `enrollmentKeyRoutes`:

```typescript
// Change:
import { enrollmentKeyRoutes } from './routes/enrollmentKeys';
// To:
import { enrollmentKeyRoutes, publicEnrollmentRoutes } from './routes/enrollmentKeys';
```

Then mount the public route. Find line 666 (`api.route('/enrollment-keys', enrollmentKeyRoutes);`) and add the public route just before it:

```typescript
api.route('/enrollment-keys', publicEnrollmentRoutes); // Public download (no auth) — must precede auth-protected routes
api.route('/enrollment-keys', enrollmentKeyRoutes);
```

- [ ] **Step 3: Verify the API compiles**

Run: `cd /Users/toddhebebrand/breeze && npx tsc --noEmit --project apps/api/tsconfig.json 2>&1 | grep -i enrollmentKey || echo "No new errors"`

Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/enrollmentKeys.ts apps/api/src/index.ts
git commit -m "feat(api): add public installer download endpoint (no auth, token-based)"
```

---

### Task 3: Add Generate Link button to AddDeviceModal

**Files:**
- Modify: `apps/web/src/components/devices/AddDeviceModal.tsx`

- [ ] **Step 1: Add state variables and the `Link` icon import**

In `apps/web/src/components/devices/AddDeviceModal.tsx`, update the imports (line 2):

```typescript
// Change:
import { Download, Copy, Loader2, Check } from 'lucide-react';
// To:
import { Download, Copy, Loader2, Check, Link } from 'lucide-react';
```

Add new state variables after the `downloadSuccess` state (after line 43):

```typescript
  // Generate link state
  const [generatedLink, setGeneratedLink] = useState('');
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState<string>();
  const [linkCopied, setLinkCopied] = useState(false);
```

- [ ] **Step 2: Reset link state when modal opens**

In the reset effect (lines 65-74), add resets for the link state. After `setDownloadSuccess(false);` (line 69), add:

```typescript
      setGeneratedLink('');
      setLinkError(undefined);
      setLinkCopied(false);
```

- [ ] **Step 3: Add `handleGenerateLink` function**

Add this function after `handleDownload` (after line 214):

```typescript
  // --- Generate public link ---
  const handleGenerateLink = async () => {
    if (linkLoading || !selectedSiteId) return;
    setLinkLoading(true);
    setLinkError(undefined);
    setGeneratedLink('');

    try {
      // Step 1: Create parent enrollment key
      const keyRes = await fetchWithAuth('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Add device link (${new Date().toISOString().slice(0, 10)})`,
          siteId: selectedSiteId,
        }),
      });

      if (!keyRes.ok) {
        const body = await keyRes.json().catch(() => ({ error: 'Failed to create enrollment key' }));
        const rawMessage = body.message || body.error || '';
        if (keyRes.status === 403 && rawMessage.toLowerCase().includes('mfa required')) {
          setLinkError('MFA_REQUIRED');
        } else {
          setLinkError(rawMessage || `Failed to create enrollment key (${keyRes.status})`);
        }
        return;
      }

      const keyData = await keyRes.json();

      // Step 2: Generate public link
      const linkRes = await fetchWithAuth(`/enrollment-keys/${keyData.id}/installer-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: selectedPlatform, count: deviceCount }),
      });

      if (!linkRes.ok) {
        const body = await linkRes.json().catch(() => ({ error: 'Failed to generate link' }));
        setLinkError(body.error || `Failed to generate link (${linkRes.status})`);
        return;
      }

      const linkData = await linkRes.json();
      setGeneratedLink(linkData.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setLinkError(`Failed to generate link: ${message}`);
    } finally {
      setLinkLoading(false);
    }
  };

  const handleCopyLink = async () => {
    if (!generatedLink) return;
    try {
      await navigator.clipboard.writeText(generatedLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
      showToast({ type: 'success', message: 'Link copied to clipboard' });
    } catch {
      showToast({ type: 'error', message: 'Failed to copy link' });
    }
  };
```

- [ ] **Step 4: Add the Generate Link button and link display to the JSX**

In the installer tab JSX, after the download button's closing `</button>` tag (after line 358), add:

```tsx
                {/* Generate Link button */}
                <button
                  type="button"
                  onClick={handleGenerateLink}
                  disabled={linkLoading || !selectedSiteId}
                  className="w-full h-10 rounded-md border border-primary text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {linkLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Generating link...
                    </>
                  ) : (
                    <>
                      <Link className="h-4 w-4" />
                      Generate Link
                    </>
                  )}
                </button>

                {/* Generated link display */}
                {generatedLink && (
                  <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 space-y-2">
                    <p className="text-xs font-medium text-green-700">
                      Share this link to download the installer from any computer:
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        readOnly
                        value={generatedLink}
                        className="flex-1 h-9 rounded-md border bg-background px-3 text-xs font-mono focus:outline-none"
                        onClick={(e) => (e.target as HTMLInputElement).select()}
                      />
                      <button
                        type="button"
                        onClick={handleCopyLink}
                        className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 flex items-center gap-1.5"
                      >
                        {linkCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        {linkCopied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Valid for {deviceCount > 1 ? `${deviceCount} downloads` : '1 download'}.
                      No login required.
                    </p>
                  </div>
                )}

                {/* Link errors */}
                {linkError === 'MFA_REQUIRED' && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700">
                    Multi-factor authentication is required to generate links.{' '}
                    <a
                      href="/settings/profile"
                      className="font-medium underline hover:no-underline"
                    >
                      Set up MFA in your profile settings
                    </a>{' '}
                    and sign in again, then retry.
                  </div>
                )}

                {linkError && linkError !== 'MFA_REQUIRED' && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    {linkError}
                    <button
                      type="button"
                      onClick={handleGenerateLink}
                      className="ml-2 underline hover:no-underline"
                    >
                      Retry
                    </button>
                  </div>
                )}
```

- [ ] **Step 5: Verify the web app compiles**

Run: `cd /Users/toddhebebrand/breeze && npx tsc --noEmit --project apps/web/tsconfig.json 2>&1 | grep -i AddDeviceModal || echo "No new errors"`

Expected: No new errors related to AddDeviceModal.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/AddDeviceModal.tsx
git commit -m "feat(web): add Generate Link button to Add Device modal"
```

---

### Task 4: Write AddDeviceModal tests

**Files:**
- Create: `apps/web/src/components/devices/AddDeviceModal.test.tsx`

- [ ] **Step 1: Create the test file with mocks and helpers**

Create `apps/web/src/components/devices/AddDeviceModal.test.tsx`:

```typescript
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AddDeviceModal from './AddDeviceModal';
import { fetchWithAuth } from '../../stores/auth';

// --- Mocks ---

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

// Re-import mocked modules to get typed references
const fetchWithAuthMock = vi.mocked(fetchWithAuth);

// Import useOrgStore so we can control its return value per-test
import { useOrgStore } from '../../stores/orgStore';
const useOrgStoreMock = vi.mocked(useOrgStore);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
    blob: vi.fn().mockResolvedValue(new Blob(['binary'])),
  }) as unknown as Response;

const SITE_A = { id: 'site-aaa-111', orgId: 'org-111', name: 'HQ Office', createdAt: '2026-01-01', deviceCount: 5 };
const SITE_B = { id: 'site-bbb-222', orgId: 'org-111', name: 'Branch Office', createdAt: '2026-01-02', deviceCount: 3 };

function setOrgStore(overrides: Partial<ReturnType<typeof useOrgStore>> = {}) {
  useOrgStoreMock.mockReturnValue({
    currentPartnerId: 'partner-1',
    currentOrgId: 'org-111',
    currentSiteId: 'site-aaa-111',
    partners: [],
    organizations: [],
    sites: [SITE_A, SITE_B],
    isLoading: false,
    error: null,
    setPartner: vi.fn(),
    setOrganization: vi.fn(),
    setSite: vi.fn(),
    fetchPartners: vi.fn(),
    fetchOrganizations: vi.fn(),
    fetchSites: vi.fn(),
    clearOrgContext: vi.fn(),
    ...overrides,
  } as ReturnType<typeof useOrgStore>);
}

// Mock clipboard
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

// Mock URL.createObjectURL / revokeObjectURL
global.URL.createObjectURL = vi.fn(() => 'blob:http://localhost/fake');
global.URL.revokeObjectURL = vi.fn();
```

- [ ] **Step 2: Add the site selector and "no sites" tests**

Append to the test file:

```typescript
describe('AddDeviceModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOrgStore();
  });

  it('renders site selector with org sites', () => {
    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    const select = screen.getByLabelText('Site');
    expect(select).toBeDefined();

    const options = select.querySelectorAll('option');
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toBe('HQ Office');
    expect(options[1].textContent).toBe('Branch Office');
  });

  it('shows no-sites warning when org has no sites', () => {
    setOrgStore({ sites: [] });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    expect(screen.getByText(/No sites available/)).toBeDefined();
  });

  it('does not render content when modal is closed', () => {
    render(<AddDeviceModal isOpen={false} onClose={vi.fn()} />);

    expect(screen.queryByText('Add New Device')).toBeNull();
  });
```

- [ ] **Step 3: Add platform switching and device count tests**

Append to the `describe` block:

```typescript
  it('switches platform when platform buttons are clicked', () => {
    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    const macosButton = screen.getByText('macOS (.zip)');
    fireEvent.click(macosButton);

    expect(macosButton.className).toContain('bg-primary');

    const windowsButton = screen.getByText('Windows (.msi)');
    expect(windowsButton.className).not.toContain('bg-primary');
  });

  it('clamps device count between 1 and 1000', () => {
    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    const input = screen.getByLabelText('Number of devices') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '5000' } });
    expect(input.value).toBe('1000');

    fireEvent.change(input, { target: { value: '0' } });
    expect(input.value).toBe('1');
  });
```

- [ ] **Step 4: Add download flow test**

Append to the `describe` block:

```typescript
  it('downloads installer on button click', async () => {
    // Mock: create enrollment key → download installer
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-123', key: 'raw-key-abc' }, true, 201);
      }
      if (url.startsWith('/enrollment-keys/key-123/installer/')) {
        return makeJsonResponse(null, true); // blob response
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Download Installer'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    });

    // Verify enrollment key was created with correct site
    const createCall = fetchWithAuthMock.mock.calls[0];
    expect(String(createCall[0])).toBe('/enrollment-keys');
    const createBody = JSON.parse((createCall[1] as RequestInit).body as string);
    expect(createBody.siteId).toBe('site-aaa-111');
  });
```

- [ ] **Step 5: Add generate link flow and copy link tests**

Append to the `describe` block:

```typescript
  it('generates a public link on button click', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-456', key: 'raw-key-def' }, true, 201);
      }
      if (url === '/enrollment-keys/key-456/installer-link') {
        return makeJsonResponse({
          url: 'https://api.example.com/api/v1/enrollment-keys/public-download/windows?token=abc123',
          expiresAt: '2026-04-14T00:00:00Z',
          maxUsage: 1,
          platform: 'windows',
          childKeyId: 'child-key-789',
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Generate Link'));

    await waitFor(() => {
      expect(screen.getByDisplayValue(/public-download/)).toBeDefined();
    });

    expect(screen.getByText(/Valid for 1 download/)).toBeDefined();
  });

  it('copies generated link to clipboard', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-456' }, true, 201);
      }
      if (url.includes('/installer-link')) {
        return makeJsonResponse({
          url: 'https://api.example.com/public-download/windows?token=abc',
          expiresAt: null,
          maxUsage: 1,
          platform: 'windows',
          childKeyId: 'child-1',
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Generate Link'));

    const copyButton = await screen.findByText('Copy');
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('public-download')
      );
    });
  });
```

- [ ] **Step 6: Add error handling and MFA tests**

Append to the `describe` block:

```typescript
  it('shows error when download fails', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-err' }, true, 201);
      }
      if (url.includes('/installer/')) {
        return makeJsonResponse({ error: 'Template MSI not available' }, false, 503);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Download Installer'));

    await waitFor(() => {
      expect(screen.getByText(/Template MSI not available/)).toBeDefined();
    });
  });

  it('shows MFA warning when enrollment key creation returns 403 mfa required', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ error: 'MFA required' }, false, 403)
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Download Installer'));

    await waitFor(() => {
      expect(screen.getByText(/Multi-factor authentication is required/)).toBeDefined();
    });
  });

  it('shows error when link generation fails', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-link-err' }, true, 201);
      }
      if (url.includes('/installer-link')) {
        return makeJsonResponse({ error: 'macOS PKG not available' }, false, 503);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Generate Link'));

    await waitFor(() => {
      expect(screen.getByText(/macOS PKG not available/)).toBeDefined();
    });
  });
```

- [ ] **Step 7: Add CLI tab test**

Append to the `describe` block, then close it:

```typescript
  it('fetches onboarding token when CLI tab is clicked', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ token: 'test-token-xyz', enrollmentSecret: 'secret-abc' })
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('CLI Commands'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/onboarding-token', { method: 'POST' });
    });

    await waitFor(() => {
      expect(screen.getByText('test-token-xyz')).toBeDefined();
    });
  });
});
```

- [ ] **Step 8: Run the tests**

Run: `cd /Users/toddhebebrand/breeze && pnpm vitest run apps/web/src/components/devices/AddDeviceModal.test.tsx`

Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/devices/AddDeviceModal.test.tsx
git commit -m "test(web): add AddDeviceModal component tests"
```

---

### Task 5: Final verification

- [ ] **Step 1: Run web tests**

Run: `cd /Users/toddhebebrand/breeze && pnpm test --filter=@breeze/web`

Expected: All tests pass (existing + new).

- [ ] **Step 2: Run API type check**

Run: `cd /Users/toddhebebrand/breeze && npx tsc --noEmit --project apps/api/tsconfig.json 2>&1 | tail -5`

Expected: No new errors.

- [ ] **Step 3: Commit any final fixes if needed**
