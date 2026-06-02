# Canonical run references & bundle signing (S21)

Calane runs are reproducible local artifacts. To make a run identifiable and
verifiable across instances, Phase 6 adds a **content-addressed canonical
reference** and an optional **detached Ed25519 signature** on exported bundles.

## The `calane://run/<hash>` URI scheme

A canonical run reference identifies a run bundle by the hash of its content,
independent of which instance produced or stores it:

```
calane://run/<bundle-hash>
```

`<bundle-hash>` is the lowercase hex SHA-256 digest (no `sha256:` prefix) of the
bundle's **canonical representation**. The host that can serve the bundle is
supplied out-of-band (see federation, S22) and is deliberately *not* embedded in
the reference — the hash alone identifies the run globally.

### Canonicalization rules

`bundleHash(files)` computes the digest deterministically so the same logical
bundle hashes identically everywhere:

1. File paths are sorted lexicographically (byte order).
2. The derived files `signature.json` and `canonical_ref.txt` are **excluded**
   (they are computed *from* the hash and would otherwise be self-referential).
3. Each remaining file contributes `"<path>\n<sha256-of-its-bytes>"` to a
   manifest text, joined with `\n`.
4. The reference hash is `sha256(manifest-text)`.

Reordering files, or adding the signature/ref files, does not change the hash;
changing any real file's content does.

## Per-instance signing keypair

On first use, Calane generates an **Ed25519** keypair (via `node:crypto`, no new
dependency) under:

```
~/.calane/keys/instance_ed25519        # PRIVATE key (PKCS#8 PEM), mode 0600
~/.calane/keys/instance_ed25519.pub    # PUBLIC key (SPKI PEM), mode 0644
```

- The **private key never leaves the instance**: it is not committed, not
  logged, and never written into any exported bundle.
- Only the **public key** and the **signature** appear in a signed bundle.
- Export the public key on demand:

  ```bash
  llm-pipe export-key
  ```

> **Key-loss implications.** The private key is the only thing that can produce
> new signatures attributable to this instance. If it is lost, previously
> exported bundles remain *verifiable* (their embedded public key + signature
> are self-contained), but this instance can no longer sign new bundles under
> the same identity, and any allowlist entry pinned to the old public key must
> be updated. Back up `~/.calane/keys/` if signature continuity matters.

## Signing a bundle

Add `--sign` when exporting:

```bash
llm-pipe export-run <run-id> --out run_bundles --sign
```

This writes two extra files into the bundle:

- `signature.json` — `{ alg: "ed25519", canonicalRef, bundleHash, signature,
  publicKey, signedAt }`. The signed message is the canonical reference
  `calane://run/<hash>`, so the signature attests to the whole bundle's content.
- `canonical_ref.txt` — the `calane://run/<hash>` reference.

Export is unchanged when `--sign` is omitted (bundles stay unsigned and
backward-compatible).

## Verifying a bundle

```bash
llm-pipe verify-bundle <bundle-path>
```

Verification:

1. Parses `signature.json` (reports `no_signature` if absent).
2. Recomputes the canonical bundle hash and checks it against the signed hash
   (integrity / tamper detection).
3. Checks the canonical reference matches the signed hash.
4. Verifies the Ed25519 signature over the canonical reference against the
   embedded public key.

To verify against a *specific* expected key (the federation allowlist path,
S22), pass `--public-key <pem-file>`; the embedded key must match it.

```bash
llm-pipe verify-bundle <bundle-path> --public-key ./trusted/remote.pub
```
