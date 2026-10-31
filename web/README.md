# Ghost Replay request workspace frontend

This is the product interface for importing, editing, executing, and retaining real public HTTPS request replays. It starts with an empty workspace. No preset contains prerecorded response results, and no sample executes automatically.

The same-origin Node API creates an anonymous private workspace with a random capability token, stores its traces/runs in SQLite, and performs bounded GET/HEAD requests through its public-address SSRF guard. This interface is not a signed-in account system, a browser-session replay, a load generator, or an unrestricted HTTP client. Redirects are not followed. Only the backend can decide whether DNS resolves to an allowed public destination.

## User flow

- **Request studio:** import a HAR file or paste its JSON, or add a GET/HEAD request. Select/edit any request, destination, captured status/body baseline, expected status, literal body inclusion, and maximum-duration assertion. Traces contain up to six requests.
- **Temporary authorization:** select an exact destination hostname and an Authorization or X-Api-Key value. The value is held only for this replay and cleared afterward. It is never saved as draft configuration, restored from history, or written to browser storage. A failed run also clears it.
- **Replay:** the actual API records status, elapsed time, body size/preview/hash, baseline differences, and assertion outcomes. The inspector shows both bodies, highlights the first differing character when present in the previews, explains missing baselines, and preserves network/policy errors without invented statuses. Configured assertions that received no usable response remain visible as **Not evaluated**, including older records whose assertion outcomes were not retained.
- **Saved traces:** explicitly save reusable request/baseline/assertion configuration; reopen/update/delete it. Drafts are memory-only until saved. Replacing an unsaved draft requires confirmation.
- **Run history:** load actual saved run records; reopen evidence, reuse sanitized requests as a new draft, export the server's saved JSON, or confirm permanent deletion. The private-workspace dialog also supports deleting all saved workspace data and starting a fresh empty workspace.

## Security and data boundaries

Only `ghost-replay-theme` and `ghost-replay-workspace` are persisted in browser storage. The latter is a bearer capability, not an account: possession grants workspace access, and loss of the browser token has no recovery flow. The token is sent in `X-Workspace-Token`; temporary outbound authorization is a separate POST-body field. Neither appears in exported run JSON.

HAR processing happens in this browser with a 5 MiB input cap. All request/response headers are discarded, recognized credential query fields are removed, and recognized credential JSON keys are redacted. Unsupported methods/private destinations are skipped with an explicit count. HAR base64 UTF-8 bodies are decoded; unsupported encoding and bodies over 4,096 characters are omitted rather than silently used as incomplete reference bodies. Status baselines are retained when valid. Review imported/private response content before saving or sharing: pattern redaction cannot identify every application-specific secret.

Manual URLs reject embedded credentials and recognized credential query fields. The request payload includes only explicit canonical fields; unknown input/header/auth properties cannot leak into saved trace configuration. Authorization must have an explicit matching hostname, never a default inferred after editing a destination. Export fetches the saved, server-redacted record again instead of serializing a live draft. All dynamic content uses text nodes, `textContent`, or input values; no response, URL, label, or HAR text is rendered as HTML.

All assets are the existing same-origin `index.html`, `styles.css`, `app.js`, and `helpers.mjs`; no external packages, fonts, images, inline scripts, or extra static routes are required. Storage failures leave the current workspace usable for this page and disclose the limited persistence. API errors preserve safe explanations and HTTP status for unreadable responses. A 35-second browser request deadline does not claim server-side success; the error directs users to check history before retrying.

## Appearance and accessibility

The Light/Dark control remembers an explicit choice. **Auto** clears it and follows the operating system, including live changes. Both palettes cover empty, loading, errors, failed assertions, diffs, body previews, and saved/history views. Appearance controls remain available during runs. Main/status/action text colors have automated normal-text contrast checks.

The interface includes a skip link, semantic headings/navigation/tables, native inputs and details, labeled read-only body previews, keyboard-operable dialogs, visible focus, live notifications, reduced-motion support, and responsive layouts down to 320px. Wide evidence tables scroll inside their panel, not across the whole page. Ctrl/Cmd+Enter replays the current studio draft when no dialog is open. Replays and saves disable duplicate submissions and request editing while pending; there is no invented cancellation control.

## Verify

From the repository root:

```sh
node --test web/*.test.mjs
node --check web/app.js
```

The web suite has **29 passing tests**: 15 new product tests for HAR decoding/filtering/limits/redaction, credential URL handling, canonical request preparation, actual backend-schema compatibility, HTTP-preview UUID fallback, safe product boundaries, and configured-but-not-evaluated assertions; seven appearance tests; and seven legacy checkout-helper regression tests. These checks do not substitute for browser or production-network validation.

Suggested browser QA against the server started by the project owner:

1. Open a fresh workspace: history and traces are empty, no request is invented, and replay/save are disabled. Follow the system theme, switch to the other palette, reload, and verify the explicit choice persists.
2. Add a request to an authorized public HTTPS endpoint, such as an owned service's `/healthz`. Set status assertion 200. Replay and verify actual status/body/timing, then open Run history and reopen the saved evidence. Reload the page and verify the same workspace's saved records remain.
3. Add a deliberately different captured status/body baseline, then replay. Verify the changed counts, failed outcome, actual assertion labels/expectations, both bodies, and first-difference marker. Remove the baseline and confirm the inspector says **no baseline**, rather than matched.
4. Import a real exported HAR through both file and paste paths. Test unsupported POST/local requests, a response over 4,096 characters, missing body content, and a Unicode base64 response. Verify explicit import warnings and header removal. Cancel an in-progress file read; its late result must not replace the draft.
5. Save a named trace, reopen it, edit it and save the update. Reuse a saved run as a new draft. Confirm deleting one run/trace affects only that item. Export JSON and inspect the actual saved record, excluding workspace identity and outbound authorization.
6. With an authorized test endpoint, use a non-sensitive temporary canary token scoped to its exact hostname. Verify it is cleared after the request, never restored with a run/trace, and absent from exported JSON/browser storage. Do not use real credentials for a UI smoke test.
7. At 320px and keyboard only, navigate studio, traces, history, request selection, import dialog, evidence panels, and confirmation dialog. Verify readable light/dark error and empty states, no outer horizontal overflow, and no duplicate Replay while a response is pending.
