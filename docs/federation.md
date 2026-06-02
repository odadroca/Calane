# Multi-instance federation (S22)

Federation lets one Calane instance fetch a signed run bundle from another over
HTTPS and keep a verified, read-only local copy. It builds directly on the
canonical references and Ed25519 signatures from S21 (see
[canonical-references.md](./canonical-references.md)).

Federation is **read-only** and trust is **explicit**: an instance only accepts
a foreign run if the bundle's embedded public key matches an entry in its trust
allowlist. There is no open or implicit trust and no key discovery.

## Trust allowlist

Trust is configured by a JSON file pointed at by `CALANE_TRUST_CONFIG`:

```json
{
  "remotes": [
    {
      "instance": "acme-prod",
      "baseUrl": "https://calane.acme.org",
      "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
    }
  ]
}
```

Each remote pins an `instance` id, its HTTPS `baseUrl`, and the Ed25519
`publicKey` (SPKI PEM) it signs bundles with. Obtain a remote's public key
out-of-band — e.g. the remote operator runs `llm-pipe export-key` and shares the
output. Key distribution is manual by design; automatic discovery is a future
concern.

## REST surface

Federation adds three endpoints (all behind the S11 bearer auth; no new
MCP/openai tool — the 8-tool surface is unchanged):

- **Serve half** — `GET /federated/bundles/<canonical-ref>`
  Exports + signs the matching local run on the fly and returns its bundle file
  map (including `signature.json`). The signing private key never leaves the
  instance; only the public key and signature are served.

- **Fetch half** — `GET /federated/runs/<canonical-ref>?instance=<id-or-url>`
  Resolves the allowlisted remote, fetches the bundle over HTTPS with a bearer
  token (`CALANE_FEDERATION_TOKEN`), verifies the embedded signature against the
  allowlisted public key, and stores it locally as a read-only foreign run with
  provenance. Returns `201` on first fetch, `200` if already present, `403` for
  an untrusted instance, `502` for a fetch/verification failure.

- **List** — `GET /federated/runs`
  Lists locally-stored foreign runs and their provenance.

## CLI

```bash
llm-pipe fetch-run calane://run/<hash> --instance acme-prod
```

Fetches the run from the allowlisted remote, verifies it, and stores it
read-only. `--instance` accepts the allowlisted instance id or its base URL.

## Foreign run semantics

- Foreign runs are stored under `<store>/foreign/<bundle-hash>/`, keyed by the
  content-addressed hash, alongside a `provenance.json`:

  ```json
  {
    "foreign": true,
    "canonicalRef": "calane://run/<hash>",
    "sourceInstance": "acme-prod",
    "sourceBaseUrl": "https://calane.acme.org",
    "signatureVerified": true,
    "fetchedAt": "2026-05-26T..."
  }
  ```

- They are **read-only**: the foreign store exposes fetch + read, never an
  update path.
- They are **not re-exportable** from this instance. A run keeps a single
  signing source — the instance that produced it. Re-serving a fetched run under
  this instance's key would forge provenance, so it is not supported.
- Verification is repeatable offline: a foreign bundle carries its own public
  key + signature, so `llm-pipe verify-bundle <foreign-dir>` (optionally with
  `--public-key`) re-checks it without contacting the remote.
