# Native account suspension handling

An explicit upstream 403 stating that the service was disabled in the account
for violation of Terms of Service is a terminal `account_suspended` error.
It is classified before project-header correction, image-model penalties and
account failover. Ordinary permission errors retain their existing behavior.
The shared CloudCode classifier also recognizes equivalent structured/gRPC
errors; native Gemini SSE errors carry the same sanitized reason.

Rejected Gemini 403 streams are inspected before retry and sanitization, with
a 64-KiB limit and a two-second deadline. Cancellation stays cancellation.
Successful response streams and other error streams are not consumed by this
inspection. Raw upstream bodies, OAuth tokens and diagnostics are not included
in the resulting public error.

The exact affected account is fenced from selection before storage is awaited.
Its existing database row is atomically marked expired, inactive and
`upstream_tos_suspended`; token and quota fields are preserved. A concurrent
snapshot reload, cooldown expiry or successful in-flight request cannot clear
the process-local fence. The persisted status excludes it after restart.
Reactivation requires operator review and a deliberate account repair/restart.

If persistence fails, the account remains fenced in the running process and
the current request remains terminal. That failure requires operator review;
the process-local fence alone cannot survive a restart after a failed write.
The separately installed CPA compatibility ingress retains its durable global
suspension stop and its existing attempt/concurrency limits. It must remain in
front of the native media service.

These changes prevent retry fan-out and accidental reuse after a known
suspension. They do not establish an account-ban probability or make consumer
Antigravity OAuth access a supported third-party API. No identity-spoofing
headers, account-rotation scheduler or system-prompt masking are added.
