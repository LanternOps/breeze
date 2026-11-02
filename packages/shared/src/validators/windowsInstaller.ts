import { z } from 'zod';

export const windowsInstallerIntegritySchema = z.object({
  url: z.string().url().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        && url.pathname.endsWith('/api/v1/agents/install.ps1') && url.href === value;
    } catch {
      return false;
    }
  }).brand<'WindowsInstallerUrl'>(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).brand<'WindowsInstallerSha256'>(),
});

export type WindowsInstallerIntegrity = Readonly<z.infer<typeof windowsInstallerIntegritySchema>>;
