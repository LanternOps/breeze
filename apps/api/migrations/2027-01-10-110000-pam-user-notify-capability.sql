-- #8928: agents that can show a PAM outcome notice (denied / expired) to the
-- user who handed an elevation request to IT report
-- securityCapabilities.pamUserNotifyProtocolVersion = 1. Heartbeats rewrite
-- this non-sticky claim every beat; missing or unknown versions become 0, and
-- the claim gate withholds pam_request_notify from any agent at 0.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS pam_user_notify_protocol_version integer NOT NULL DEFAULT 0;
