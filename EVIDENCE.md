# V2 evidence contract

This envelope describes only the bundled `checkout-v1` fixture. It is not an arbitrary Sentry event format, executable replay script, or signed incident record.

| Field | Required meaning |
| --- | --- |
| `schema_version` | Integer `2`; booleans and unknown versions are rejected |
| `fixture` | Exact `checkout-v1` kind, integer stock, `fixture` provenance, and descriptive source |
| `schedule` | Complete allowlisted operation sequence, `hypothesis` provenance, and descriptive source |
| `source` | `derived` SHA-256 for `ghost_replay/core.py`, matched against the current local engine |
| `evidence` | Distinct capture ID, `observed` category, fixed capture mechanism, runtime metadata, and complete run |
| `config_sha256` | Hash of the fixture kind, initial stock, and scheduling recipe |
| `content_sha256` | Hash of every top-level field except this checksum itself |

There are no optional fields in this version. Unknown fields, missing required inputs, duplicate JSON keys, non-finite numbers, and invalid UTF-8 fail explicitly. File reads are bounded to 100,000 bytes. The allowlist rejects arbitrary operations and external destinations; telemetry strings are never executed. Operation labels are limited to 200 characters.

## Canonical JSON

Canonicalization is the Python standard-library JSON representation with sorted keys, compact separators, Unicode retained and encoded in UTF-8, and NaN/Infinity prohibited. It is an explicitly defined project convention, not a claim to implement RFC 8785. Export adds a single trailing newline outside the hashed value. Reordering object keys or changing indentation does not change the checksum.

The recipe hash deliberately excludes the captured handler mode so the same recipe can compare buggy and fixed implementations. The capture's actual mode and observations remain covered by the content checksum. A replay report identifies its imported envelope and independently reports its chosen execution mode.

## What validation establishes

The importer checks both hashes, the current fixture-engine fingerprint, exact event order, read/commit observations, response records, and the inventory invariant result. A changed engine is rejected rather than downloaded or executed. The source fingerprint covers the fixture engine only: it does not fingerprint Python, the operating system, the importer, or the entire repository. Runtime metadata is descriptive, not an environment equivalence guarantee.

An attacker can produce a different plausible fixture transcript and recompute its checksums. Validation establishes consistency with this narrow contract, **not capture authenticity**. It cannot establish that a claimed observation came from Sentry, a real customer, or a trusted recorder. Signing and recorder identity are not implemented.

## Legacy compatibility

V1 accepts exactly `schema_version`, `stock`, and `schedule`. It is an unsealed recipe with no captured observations, source fingerprint, or content checksum. `reproduce` can execute it; `capture` can run it and create a new v2 envelope. `export-bundle` requires an existing v2 capture and never invents missing evidence. No migration infers missing fields.

## Failure behavior

The public validator returns typed `BundleError` for malformed documents. CLI input/validation failures exit 2 with a diagnostic. Inspection and export do not execute requests. Reproduction/capture execute only the local, trusted checkout fixture over loopback HTTP. There is no imported code or selectable network destination.
