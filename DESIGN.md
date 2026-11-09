# Design

## Source of truth
Active, 2026-11-09. Embedded `/dashboard` and protected `/admin/dashboard`. Evidence: Nest/Fastify server, AdminGuard, account repository and quota diagnostics; no previous UI, theme, assets or screenshot baseline exists.

## Brand
Private operational console: calm, clear, restrained. Trust comes from timestamps, explicit unknowns and session scope. Avoid decorative charts and implied availability guarantees.

## Product goals
See account availability, configured project activity and recent successful/failed requests. No credential editing, request contents or account mutation. Success means an administrator can locate a failure and its project without exposing secrets.

## Personas and jobs
Proxy administrator diagnosing account capacity or client failures from desktop or phone.

## Information architecture
Public login shell → authenticated overview → accounts → runtime model capacity → projects → session request journal. Refresh and exit remain visible.

## Design principles
Summarize first; show unknown separately from unavailable. Record HTTP outcomes, never prompts. Prefer native elements and explicit text over color alone.

## Visual language
Dark navy background, pale text, muted slate metadata, mint success, coral errors. System sans font; tabular numeric data; 8px spacing base, rounded bordered cards. No external fonts, imagery or animation. CSS tokens live in dashboard page source.

## Components
Password login form; status banner; four metric cards; horizontally scrollable account, quota, project and request tables; native status/project selects; refresh and exit buttons. All values render with textContent.

## Accessibility
Target WCAG 2.2 AA: semantic headings/tables, visible keyboard focus, explicit labels, live status region, text status indicators, high contrast. No motion or hover-only interactions.

## Responsive behavior
Four summary columns become two below 760px. Tables scroll within their card; buttons wrap. Form and touch controls retain comfortable height.

## Interaction states
Initial locked shell contains no private data. Loading banner during fetch; explicit authorization/network error; empty-table copy; last update on success. Slow requests time out after 15 seconds; polling every 15 seconds. Exit clears memory and private rendered data.

## Content voice
Concise Russian operational wording. “По снимку” for stored account capacity; runtime diagnostics separately show actual model requestability. State session-only retention and lack of response/error bodies.

## Implementation constraints
Self-contained HTML/CSS/JS, no UI dependencies or external requests. Admin key stays in closure memory and travels only in Authorization. API uses AdminGuard and no-store. Journal holds 500 completed requests in memory; lifetime counters remain session totals. Tests cover auth, whitelisted snapshots, redaction, bounds and markup. Browser screenshot acceptance is desirable; no existing visual baseline.

## Open questions
- [ ] Persist journal across restarts? Owner: operator; currently deliberately session-only.
