# Internal Trust Register

This register captures Redis-backed and process-local trust points that affect security, correctness, or degraded-mode behavior.

| trust_point | backing_store | fail_mode_today | restart_safe | security_sensitive | notes |
| --- | --- | --- | --- | --- | --- |
| Public BMR rate limiting | Redis sorted sets | Fail closed via `rateLimiter()` when Redis is unavailable or Redis commands fail | Yes, assuming Redis persists | Yes | Covers public `/api/v1/backup/bmr/recover/authenticate`, `/download`, and `/complete` abuse control paths |
| Agent enrollment rate limiting | Redis sorted sets | Fail closed via `rateLimiter()` when Redis is unavailable or Redis commands fail | Yes, assuming Redis persists | Yes | Protects public `POST /api/v1/agents/enroll` against brute force and replay |
| Agent WebSocket reconnect limiting | Process memory | Sliding-window limit resets on API restart and is local to a single process | No | Medium | Intentionally ephemeral; agent reconnect storms are availability-sensitive, not a durable correctness requirement |
| Access-token revocation checks | Redis string keys | Degraded fail-open after this pass when Redis is unavailable or revocation lookup errors occur | Yes, assuming Redis persists | Yes | JWTs remain cryptographically valid; revocation outages are logged as degraded auth state instead of bricking authenticated traffic |
| Refresh-token JTI revocation checks | Redis string keys | Fail closed when Redis is unavailable or revocation lookup errors occur | Yes, assuming Redis persists | Yes | Refresh token replay prevention remains strict because refresh is itself a token-issuance boundary |
| Verification result matching | Database (`backup_verifications.details.commandId`) | DB-backed lookup; in-memory cache is only a convenience layer | Yes | Medium | Previously incorrect ephemeral state; fixed earlier by durable lookup on `commandId` |
| Agent WebSocket connection map | Process memory | Lost on restart; agents reconnect and recover naturally | No | Medium | Correctly ephemeral; should not be moved into Redis just for persistence |
| Stale command cleanup | BullMQ + database | Reaper marks timed-out commands failed; linked restore/DR state now also receives timeout propagation | Yes | Medium | Timeout handling must update `restore_jobs` and trigger DR reconciliation for commands carrying DR metadata |
| Distributed queue and worker coordination | Redis / BullMQ | High-privilege queues fail closed if Redis is unavailable because `getRedisConnection()` throws | Yes, assuming Redis persists | Yes | Queue payload validation and worker-side validation are handled in the earlier queue hardening pass |
| Event bus streams | Redis streams | Durable enough for internal consumers; replayable through streams | Yes, assuming Redis persists | Medium | Used for operational events, not auth decisions |
| Event bus live pub/sub | Redis pub/sub | Best-effort delivery; messages are dropped on subscriber disconnect or Redis restart | No | No | Used for real-time fan-out and notifications; no security-sensitive correctness should depend on pub/sub delivery |
| Notification rate limiting | Optional Redis | Explicit fail-open by disabling notification throttling when Redis is unavailable | Yes, assuming Redis persists | No | Acceptable availability tradeoff; not a security boundary |
| API key rate limiting | Redis sorted sets | Fail closed via `rateLimiter()` when Redis is unavailable or Redis commands fail | Yes, assuming Redis persists | Yes | Protects authenticated but security-sensitive API key usage |
| Global auth/public endpoint rate limiting | Redis sorted sets | Fail closed via `rateLimiter()` when Redis is unavailable or Redis commands fail | Yes, assuming Redis persists | Yes | Covers login, password reset, MFA, registration, invite acceptance, phone auth, and similar abuse-control surfaces |

## Notes

- Production `docker-compose.yml` already configures authenticated Redis with `--requirepass` and `--maxmemory-policy noeviction`.
- The dev compose files still allow looser Redis defaults for local ergonomics; runtime code should warn loudly if production falls back to insecure Redis configuration.
- Pub/sub remains intentionally best effort. Any future security-sensitive state invalidation must use durable storage plus reconciliation, not pub/sub alone.
