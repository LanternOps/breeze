import { test, expect } from '@playwright/test';

/**
 * Minimal debug test to diagnose why some pages redirect to /login
 * while others work fine with the same stored auth state.
 */
test.describe('Debug Auth State', () => {
  test('dump auth state on a PASSING page (/alerts/rules)', async ({ page }) => {
    await page.goto('/alerts/rules');

    // Wait a moment for hydration
    await page.waitForTimeout(2_000);

    const url = page.url();
    const authState = await page.evaluate(() => {
      const raw = localStorage.getItem('breeze-auth');
      return raw ? JSON.parse(raw) : null;
    });

    console.log('=== PASSING PAGE: /alerts/rules ===');
    console.log('Final URL:', url);
    console.log('Auth state:', JSON.stringify(authState, null, 2));
    console.log('Has tokens:', !!authState?.state?.tokens?.accessToken);
    console.log('isAuthenticated:', authState?.state?.isAuthenticated);

    // Check if we stayed on the page
    expect(url).not.toContain('/login');
  });

  test('dump auth state on a FAILING page (/devices)', async ({ page }) => {
    // Listen for all navigations
    const navigations: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        navigations.push(frame.url());
      }
    });

    // Listen for console messages from AuthOverlay
    page.on('console', (msg) => {
      console.log(`[browser console] ${msg.type()}: ${msg.text()}`);
    });

    // Intercept API calls to see if any 401s trigger logout
    const apiResponses: { url: string; status: number }[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/')) {
        apiResponses.push({ url: response.url(), status: response.status() });
      }
    });

    await page.goto('/devices');

    // Wait for potential redirect
    await page.waitForTimeout(5_000);

    const url = page.url();
    const authState = await page.evaluate(() => {
      const raw = localStorage.getItem('breeze-auth');
      return raw ? JSON.parse(raw) : null;
    });

    console.log('=== FAILING PAGE: /devices ===');
    console.log('Final URL:', url);
    console.log('Navigations:', navigations);
    console.log('Auth state:', JSON.stringify(authState, null, 2));
    console.log('Has tokens:', !!authState?.state?.tokens?.accessToken);
    console.log('isAuthenticated:', authState?.state?.isAuthenticated);
    console.log('API responses:', apiResponses);

    // This will show us whether it redirected
    if (url.includes('/login')) {
      console.log('!!! REDIRECTED TO LOGIN !!!');
      console.log('Auth state AFTER redirect:', JSON.stringify(authState, null, 2));
    }
  });

  test('test API directly with stored token', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1_000);

    const result = await page.evaluate(async () => {
      const raw = localStorage.getItem('breeze-auth');
      const authState = raw ? JSON.parse(raw) : null;
      const token = authState?.state?.tokens?.accessToken;

      if (!token) {
        return { error: 'No token in localStorage', authState };
      }

      // Try hitting the devices API directly
      const apiHost = (window as any).__PUBLIC_API_URL || '';
      const apiUrl = apiHost ? `${apiHost}/api/v1/devices` : '/api/v1/devices';

      try {
        const response = await fetch(apiUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          credentials: 'include',
        });

        const body = await response.text();
        return {
          status: response.status,
          url: apiUrl,
          token: token.substring(0, 20) + '...',
          bodyPreview: body.substring(0, 200),
        };
      } catch (e: any) {
        return { error: e.message, token: token.substring(0, 20) + '...' };
      }
    });

    console.log('=== DIRECT API TEST ===');
    console.log(JSON.stringify(result, null, 2));
  });
});
