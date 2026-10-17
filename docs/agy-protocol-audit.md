# AGY and the compatibility proxy

The compatibility route is not a transparent wire relay. AGY sends CloudCode envelopes;
the adapter sends the inner request to CPA's Gemini API, and CPA reconstructs its own
CloudCode envelope. Header cleanup does not establish native-client equivalence.

## Source findings

The audited CPA revision is `355fd10e76b82e03ba6625acc583b900286e4bf2` (8.0.31):

- Generation sets authorization, content type and its resolved user agent. There is no
  automatic generation `x-goog-api-client` header. Per-account HTTP user-agent overrides
  do not cover OAuth refresh, discovery and model listing consistently.
- The default HTTP user agent identifies an Antigravity Hub client on macOS ARM64.
  That default is not evidence of the installed AGY CLI platform or version.
- The executor regenerates request IDs, sets body `userAgent` to `antigravity`, selects
  the credential's project and preserves an explicit inner `sessionId`.
- The Gemini translator normalizes tools, signatures and roles. The executor removes
  safety settings and Gemini output-token limits. Optional configured payload rules
  can introduce further changes. System-prompt injection is commented out in this revision.
- Independent native `web_search` has special request-type semantics. Stripping that
  envelope and silently reclassifying it as `agent` is not equivalent behavior.

See the pinned [request builder](https://github.com/router-for-me/CLIProxyAPI/blob/355fd10e76b82e03ba6625acc583b900286e4bf2/internal/runtime/executor/antigravity_executor_request.go),
[Gemini translator](https://github.com/router-for-me/CLIProxyAPI/blob/355fd10e76b82e03ba6625acc583b900286e4bf2/internal/translator/antigravity/gemini/antigravity_gemini_request.go),
and [transport implementation](https://github.com/router-for-me/CLIProxyAPI/blob/355fd10e76b82e03ba6625acc583b900286e4bf2/internal/runtime/executor/antigravity_executor.go).

## Deployment safeguards

The native proxy filters local metadata and honors an explicit upstream-version pin.
The compatibility-adapter [patch](../ops/cliproxy/request-type.patch) applies to
`Horcag/arina-openclaw@59296816781dae730a2790844caa07d9636985f4`.
It preserves missing/`agent` request types and rejects malformed or unsupported explicit
request types before invoking CPA. Separate image and transcription routes are unchanged.
The patch includes its regression tests; it is a deployment artifact for the adapter owner.

The supported credential-scoped pool configuration reduces repeated connection setup:

```yaml
oauth:
  providers:
    antigravity:
      connection-pool:
        enabled: true
        idle-conn-timeout: "30s"
        max-idle-conns-per-host: 2
```

Pooling is disabled by default in this CPA revision. See the pinned
[configuration example](https://github.com/router-for-me/CLIProxyAPI/blob/355fd10e76b82e03ba6625acc583b900286e4bf2/config.example.yaml).
Keep one-credential retry limits, cooldown persistence and the explicit suspension stop.

These changes address identifiable compatibility and traffic problems. They do not
measure account-suspension probability or prove that Google cannot identify the proxy.
Exact native request headers and envelopes require a successful dynamic observation;
static binary strings and upstream comments alone cannot establish them.
