-- NULL means the agent did not identify the Windows system drive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.device_disks ADD COLUMN IF NOT EXISTS is_os_volume boolean;
