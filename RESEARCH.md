# Research and next scope

Investigated 2026-10-29. Product capabilities can change.

## Existing overlap

- [Seer issue fix API](https://docs.sentry.io/api/seer/start-seer-issue-fix/) already covers root cause, solution, generated changes, and PR creation.
- [Seer PR iteration](https://sentry.io/changelog/seer-pr-iteration/) includes failed-CI repair and requesting regression tests. Generic issue-to-test generation would not be a distinctive project.
- [Session Replay](https://sentry.io/product/session-replay/) connects user actions with errors and traces. Its [FAQ](https://www.sentry.help/en/articles/13964404-session-replay-faq-web) describes an HTML reconstruction, not application/backend reexecution.
- [Replay quickstart](https://sentry.io/quickstart/session-replay/) documents default masking. [Body capture guidance](https://www.sentry.help/en/articles/13965227-javascript-can-i-include-the-request-and-response-body-in-my-errors) distinguishes optional Replay body capture from normal error event payloads. Never assume missing inputs can be recovered.
- [Playwright HAR mocking](https://playwright.dev/docs/mock) provides network fixture replay, including strict method/URL and POST body matching. HAR alone does not restore backend state or concurrency.

## Useful distinct direction

The opportunity is an independently inspectable experiment connecting observed evidence, explicit assumptions, a reproducible invariant failure, and a patch comparison. This prototype exercises that chain for one controlled race with no AI dependency.

Next milestone: instrument a browser checkout fixture with Playwright; record allowlisted actions and sanitized request fixtures; add a versioned evidence bundle with code hashes; replay known fixtures and compare business invariants. The logical scheduler should remain separate from recorded network timing, and inferred preconditions must remain visibly hypothetical. Sentry JSON import should be optional and fail explicitly when a required fixture is absent. Do not execute instructions or code embedded in telemetry.

## Implemented on 2026-10-31

The versioned evidence portion is now implemented for the existing controlled HTTP fixture: strict v2 import/export, engine/configuration/content hashes, explicit provenance, consistency checks, and rejection of incomplete or unsupported input. The legacy v1 recipe remains supported. Checksums are explicitly not authentication; a self-consistent forged record cannot be distinguished by these checks alone.

The next scope remains actual browser capture and more independent fixtures. The current importer does not accept rrweb, arbitrary Sentry JSON, HAR, or production database snapshots. The project remains Python because this milestone validates an HTTP/evidence contract rather than executing model inference; a native rewrite would not improve that contract without a demonstrated processing bottleneck.

Future evaluation should include multiple independent bug fixtures, held-out timing conditions, shrinking meaningful action sequences, random seeded schedules, and incomplete evidence. Do not claim general concurrency correctness, arbitrary production replay, or a measured engineering-time reduction without additional evidence.
