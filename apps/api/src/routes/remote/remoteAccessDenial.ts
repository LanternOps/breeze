import type { PermissionDenial } from '../../middleware/auth';

/**
 * #11621: what a caller without `remote:access` gets from every route that
 * starts or hands out remote access (`/remote/*` and the third-party launcher
 * POST /devices/:id/remote-access-launch). The built-in viewer roles, and any
 * custom role, can see a device without this grant, so the refusal names it
 * instead of the bare "Permission denied" the dashboard could only show as
 * "Connection failed". Still a 403. The web app switches on the code
 * (ConnectDesktopButton); keep the string in step with it.
 */
export const REMOTE_ACCESS_PERMISSION_REQUIRED_CODE = 'REMOTE_ACCESS_PERMISSION_REQUIRED';

export const REMOTE_ACCESS_DENIAL: PermissionDenial = {
  code: REMOTE_ACCESS_PERMISSION_REQUIRED_CODE,
  message:
    'Remote access requires the remote:access permission, which your role does not include. Ask an administrator to add it to your role.',
};
