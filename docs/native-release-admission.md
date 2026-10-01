# Native release admission

The running proxy reads `/var/lib/antigravity-proxy-release-controller/gate/request` before
admitting native HTTP requests, CONNECT tunnels, intercepted requests on existing
tunnels, and scheduled/startup quota refresh. An absent request allows work;
malformed, unreadable, unstable or non-root-owned input fails closed. The request
is a regular sealed file containing `queue_` plus 32 lowercase hexadecimal digits.
All production ancestors are root-owned and not group/other writable, so the service cannot rename the controller or gate. The gate parent is root:service 0750; its `ack` child is root:service 0770.

`ack/status.json` is the atomic, fsynced heartbeat. `ack/quiesce.json` exists only
for a valid current token and zero requests, tunnels and background tasks. Both
include schema version 1, PID, `/proc/self/stat` start ticks, boot UUID, timestamp,
state, readiness and counts. When ProcSubset hides boot_id, the installer must
provide the stable root-owned 0640 `gate/boot-id` file. Receipts contain no
credentials. Release acceptance must compare actual PID/start ticks/boot UUID,
current token, fresh timestamp, ready=true, closing=false, state=gated and all
three zero counters; a file's existence alone is insufficient.

Only GET `/health` bypasses admission, exposing `release_admission` status.
Accepted streams and tunnels continue normally when gated. Async handlers remain
counted after response disconnect until their work settles. DNS callbacks and
both sides of TCP tunnels remain counted until actual completion. A persistent
accepted tunnel can intentionally prevent a zero ACK until its client closes.

Explicit server shutdown destroys sockets and awaits socket close, DNS callbacks,
intercepted handlers and TLS server closure; its five-second bound rejects on
incomplete cleanup. It never reports completed drain by clearing live counters.
Heartbeat publication starts after service initialization and CONNECT attachment.
