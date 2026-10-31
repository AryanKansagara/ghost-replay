# Incident laboratory frontend

This vanilla HTML/CSS/module-JavaScript dashboard calls the same-origin `POST /api/run` endpoint. Every result, event, count, reduction, download, and elapsed time comes from that response. No preset contains prerecorded outcomes. The interface offers the six valid A/B read-before-commit schedules, inventory 0–3, and optional `noise:catalog` / `noise:help` operations.

The server must serve `index.html`, `styles.css`, `app.js`, and `helpers.mjs` from this directory, with JavaScript MIME types for the modules. Error responses may use `{error:{code,message},requestId}` with `Retry-After`. The request is `{schedule,stock}`; the response is `{runId,buggy,fixed,minimization,summary}` with the actual core reports. No remote integrations or client-side cancellation control are claimed. The client has a 20-second request deadline; the backend owns experiment execution and cancellation on disconnection.

Run pure helper tests from the repository root:

```sh
node --test web/helpers.test.mjs
```

Seven tests exercise all six schedules at each offered inventory value with/without noise; malformed input and restricted shell text; safe quoted-heredoc CLI recipes; zero/negative/rejected event presentation; report/input binding; witness reductions; and safe text error messages. These are helper tests, not a claim of browser accessibility certification.

Browser QA against the actual server:

1. At desktop width, load the page: no output metrics should be prefilled, and exports are disabled. Run the default shared-snapshot schedule with one unit and noise enabled. Expect vulnerable accepted **2**, inventory **−1**, invariant violated; fixed accepted **1**, inventory **0**, invariant preserved. Both observed event lists include the same six operations. The reduced witness has four operations and two removed noise steps.
2. While a request is pending, the run button, schedule radios, inventory, and noise checkbox are disabled. A second run cannot be submitted. No fake cancel control appears.
3. Select **A completes first** at one unit: both handlers accept one checkout, no invariant violation, and no minimized failing witness. Inventory **0** accepts zero checkouts in both modes; inventory **2** allows both without a violation. Zero values must remain visible.
4. Change an input after a completed run: all previous observations and exports clear. Run again. Download JSON must contain the actual last response/run ID. Copy CLI must describe the completed run's input and use a quoted heredoc, with both buggy and fixed reproduction commands. The always-available “Inspect reproduction commands” disclosure contains a labeled read-only textarea for manual copying. If HTTP preview clipboard access fails, that disclosure opens automatically, selects the commands, and explains Ctrl/Cmd+C; the interface does not claim clipboard success.
5. Test at 390px viewport width: settings, metric cards, both stacked timelines, witness, and export actions must fit without horizontal overflow. At keyboard only, Tab to the preset radio group and use arrows; labels and focus rings should remain visible. Ctrl/Cmd+Enter runs the comparison. Status and errors use live regions; no focus is stolen on completion.
6. Stop the local backend or inspect an endpoint error: a visible error explains the incomplete run, no result is fabricated, controls re-enable, and exports remain disabled. HTTP 429/503 retry guidance is shown when the response supplies it.

All dynamic strings render with `textContent`/text nodes. No external fonts, images, packages, or remote scripts load. The UI declares the controlled local fixture scope prominently. Native radios, checkbox, select, buttons, semantic sections, ordered event lists, focus-visible styles, reduced-motion support, and a skip link provide an accessible baseline; actual assistive-technology validation remains future work.
