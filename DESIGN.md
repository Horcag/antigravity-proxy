# Antigravity Proxy administrative console

## Source of truth
Active 2026-11-09. React frontend in `web/src/agp`, mounted by `web/src/App.tsx`. Upstream MIT UI: BlueSkyXN/CPA-Panel-LTS pinned to `72247c812be814f2158927c2f8d3ffded7c688c1` (`web/UPSTREAM.json`, unmodified full `web/LICENSE`). The old handmade dashboard is superseded. Backend contracts live under `src/admin-console` and `src/observability`.

## Brand and product goals
Private operational console for managing real Google accounts, model capacity, projects and runtime settings, and investigating persistent metadata. Russian operational copy, explicit freshness and unknown measurements. No request/response contents or existing bearer secrets displayed.

## Personas and jobs
Administrator: check capacity, add or retire an account, manage project keys, identify a failed request and compare account/model outcomes over a selected period.

## Information architecture
Cookie session → separate hash routes: overview `/`, accounts `/accounts`, models `/models`, projects `/projects`, requests `/requests`, statistics `/statistics`, settings `/settings`, attribution `/about`. Every operational section exposes refresh. No unsupported CPA provider/plugin controls.

## Design principles
Reuse the pinned frontend's actual components and styles. Reflect server data and accepted actions. Distinguish catalog membership, requestability, stale quota and unavailable measurements. Confirm deletion, rotation and account reactivation; require explicit review when Google restrictions apply.

## Visual language
Upstream CPA Panel LTS light neutral theme, sidebar navigation, bordered surfaces, muted metadata, green success and red warning labels. Preserve upstream global tokens and responsive table/chart styles; adapter SCSS adjusts only supported console composition. No remote fonts, scripts or CDN dependencies.

## Components and upstream reuse
Direct imports: SidebarNavigation and sidebarNavigationModel; Card, Button, Input, Modal; complete Table suite; ThroughputChart with its SCSS, helpers and Collapsible; Russian translation resources and global themes/components/layout/reset. The upstream runtime auth store, provider APIs and multi-server shell are bypassed by a same-origin typed adapter rather than emulated CPA responses. Modal/Sheet timer refs have a narrow browser-number typing fix. Full MIT notice is also rendered on `/about` and attribution remains visible in sidebar/footer.

## Accessibility and responsive behavior
Semantic headings, labeled inputs, table header scopes, live loading/error/success regions, keyboard focus, skip link, upstream modal focus trapping and Escape dismissal. Four metric columns reduce to two; sidebar becomes a menu on narrow screens; tables scroll within upstream wrappers. Reduced motion preference disables animation.

## Interaction states
Session check on initial load preserves valid remembered sessions. Remember defaults to seven days. Login names `AG_PROXY_ADMIN_API_KEY` as the server-side password source. Every page has loading, server/offline error, empty and refreshed states. Mutations show pending/error/success; credentials clear after import/OAuth or closing the modal. Google flow uses server state-bound callback polling with manual code/URL fallback. Project secrets appear once after creation/rotation, support clipboard copy and clear on close.

## Data contracts and content voice
`/admin/session` GET/POST/DELETE establishes HttpOnly SameSite session; mutation headers carry session CSRF. `/admin/console`: accounts/import/PATCH/DELETE/quota refresh and quota diagnostics; models and aliases; projects CRUD/rotate; settings; OAuth start/status/exchange; requests with server pagination and account/project/model/status/date filters; statistics with dated totals, per-day/per-hour/per-model and account attempt aggregates. Overview defaults to hourly buckets, statistics to daily; both offer a labeled grouping selector and explicit UTC chart labels. Native service requests show their allowlisted operation and authorization source; old opaque records are identified without guessing their operation. Request detail contains allowlisted metadata and attempt history only. Null/absent tokens and TTFT render “Неизвестно”; counters known to be zero remain zero. Request search explicitly applies to the loaded page. Counts reflect retained history, with retention bounds shown.

## Implementation constraints and validation
Single HTML Vite build, served from the same origin by Node. Active adapter never stores management password or bearer keys in local/session storage, and refuses external API destinations or redirects. Browser credentials transfer only through explicit login/import/OAuth operations. Existing project keys are absent from read responses. No production account mutations are needed for validation. Targeted adapter tests verify auth/CSRF/origin/error/mapping/unknown semantics; `lint:agp`, full TypeScript check and single-file production build validate integration. Browser acceptance is owned by root integration.

## Open questions
None affecting the current supported contract. Legacy requests before persistent recording are unavailable; live Google OAuth still requires the operator's actual authorization and is not fabricated by local tests.
