import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #9154: these pages use bare Layout.astro, which has no toast host (only
// DashboardLayout mounts <ToastContainer>). Without one, every showToast /
// runAction failure toast on them is silently dropped.
const BARE_REMOTE_PAGES = [
  'src/pages/remote/vnc/[tunnelId].astro',
  'src/pages/remote/terminal/[deviceId].astro',
  'src/pages/remote/tools.astro',
];

describe('bare-Layout remote pages mount a toast host (#9154)', () => {
  it.each(BARE_REMOTE_PAGES)('%s renders <ToastContainer client:load />', (page) => {
    const source = readFileSync(join(process.cwd(), page), 'utf8');
    expect(source).toMatch(/import ToastContainer from '[./]+\/components\/shared\/Toast';/);
    expect(source).toContain('<ToastContainer client:load />');
  });
});
