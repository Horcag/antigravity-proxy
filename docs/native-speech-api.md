# Native speech API

The native speech endpoints use the application API key and automatically select an eligible
account from the existing pool. They do not accept account selection or separate credentials.
Batch audio decoding requires `ffmpeg` on the server; set `AG_PROXY_FFMPEG_PATH` if it is not
available on `PATH`.

## Batch transcription

`POST /v1/audio/native/transcriptions` accepts multipart form data with one `file`, or JSON with
`audio` containing a base64 audio data URL. For example:

```bash
curl --fail-with-body http://127.0.0.1:8045/v1/audio/native/transcriptions \
  -H "Authorization: Bearer $AG_PROXY_API_KEY" \
  -F 'file=@recording.wav' \
  -F 'language=en-US'
```

Both forms accept these optional fields:

| Field | Meaning |
| --- | --- |
| `model` | An advertised native speech model; defaults to the first advertised model. |
| `language` | Language tag, such as `en-US`. |
| `context` | Caller-supplied context, up to 8,000 characters. |
| `vocabulary` | Array of up to 100 nonempty terms, each at most 100 characters. In multipart, send a JSON-encoded array as a field. |
| `timeout_ms` | Wall-clock deadline from 1,000 to 300,000 ms; default 120,000 ms. |
| `stream` | Boolean; when true, return server-sent events (SSE). |

Context and vocabulary come only from the caller; the proxy does not automatically add personal
information or prompts. There is no `prompt` parameter. The uploaded file limit is 25 MiB and
decoded audio is limited to five minutes. Pausing input does not pause the deadline.

Without streaming, the JSON result contains `text`, `draft_text`, `final_text`,
`draft_received`, `final_received`, `completed`, `model`, `elapsed_ms`, and `source`
(`antigravity-native-stt`). `text` and `final_text` are null until native final text is received;
`draft_text` may be empty. Final text is confirmed by the native service, not cleaned up by a
chat model. A partial result can include an `error` with `code` and `message`; inspect the flags
and `completed` rather than assuming a successful HTTP response means completion.

## Live transcription

`POST /v1/audio/native/transcriptions/stream` accepts a streaming body of mono signed PCM16LE
at 16 kHz with `Content-Type: audio/pcm;rate=16000`. Pass the options above in the query string;
streaming is always enabled. Live PCM is limited to five minutes, and the same wall-clock
deadline applies even while audio is paused. Disconnecting the HTTP request cancels the operation;
clients can map their R, M, or Escape controls to that cancellation.

For example, pipe raw PCM into this Node.js client (set `AG_PROXY_API_KEY` first):

```js
const http = require('node:http');

const request = http.request({
  hostname: '127.0.0.1', port: 8045,
  path: '/v1/audio/native/transcriptions/stream?language=en-US',
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.AG_PROXY_API_KEY}`,
    'Content-Type': 'audio/pcm;rate=16000',
  },
}, (response) => response.pipe(process.stdout));
request.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
process.stdin.pipe(request);
```

Both streaming endpoints emit SSE events `ready`, `draft`, `final`, and `completed`. Each `data`
line is JSON with a `type`; `ready` includes `model`, `draft` and `final` include `text`, and
`completed` wraps the batch-shaped result in `result`. An `error` event carries an `error` object
if a failure occurs after streaming starts. Before streaming starts, errors use an HTTP error status
and JSON `{ "error": { "code": ..., "message": ... } }`.

## Models and current status

`GET /v1/audio/native/models` returns the selected account's dynamically advertised `models`,
`default_model`, and `source`. `models/proactive-observer-v10` was observed on 2026-11-10;
query the endpoint instead of assuming it remains available.

Transport and mock integration have been tested, but successful native transcription with a real
account has not yet been verified. The currently active existing pool token lacks the
`https://www.googleapis.com/auth/aicode` scope and returns HTTP 403 `speech_scope_required`;
this is not a ToS violation. The existing OAuth authorization request already includes that scope.
Use the management console's Add account or reconnect flow to grant it and import the same account,
then retry. A successful real transcription is still needed to establish end-to-end acceptance.
