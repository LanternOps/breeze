/**
 * The body schema of POST /devices/:id/software/{update,uninstall}, shared by
 * the route and the `manage_device_software` AI tool (full-control W12, #6782).
 * Moved verbatim from routes/devices/softwareActions.ts.
 */
import { z } from 'zod';

// Same name/version constraints as the agent's validateSoftwareName /
// validateSoftwareVersion. Keeping these synchronized prevents a request
// that the API would accept from coming back as a generic validator error
// from the agent.
const SOFTWARE_NAME_UNSAFE = /[\\/\x00\r\n']/;
const SHELL_META = /[;&|><`$'"]/;

export const softwareActionPayloadSchema = z
  .object({
    name: z
      .string()
      .min(1, 'name is required')
      .max(200, 'name exceeds 200 characters')
      .refine((v) => !v.startsWith('-'), { message: 'name must not start with "-"' })
      .refine((v) => !v.includes('..'), { message: 'name contains invalid traversal sequence' })
      .refine(
        (v) => !SOFTWARE_NAME_UNSAFE.test(v) && !SHELL_META.test(v),
        { message: 'name contains unsafe characters' }
      ),
    version: z
      .string()
      .max(100, 'version exceeds 100 characters')
      .refine((v) => v === '' || !v.startsWith('-'), { message: 'version must not start with "-"' })
      .refine((v) => !v.includes('..'), { message: 'version contains invalid traversal sequence' })
      .refine(
        (v) => !SOFTWARE_NAME_UNSAFE.test(v) && !SHELL_META.test(v),
        { message: 'version contains unsafe characters' }
      )
      .optional(),
    // Optional winget package identifier (e.g. "Mozilla.Firefox"). When the
    // Software tab has correlated the row to an available third-party update it
    // sends the winget Id so the agent can upgrade by `--id` (reliable) instead
    // of guessing from the display name. Matches the agent's validWingetPkgID.
    packageId: z
      .string()
      .max(256, 'packageId exceeds 256 characters')
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, { message: 'packageId contains invalid characters' })
      .optional(),
  })
  .strict();
