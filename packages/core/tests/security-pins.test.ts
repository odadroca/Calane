import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Regression test for security-critical dependency pins.
 *
 * Each `it` block here corresponds to a CVE / GHSA we have explicitly
 * remediated; if a future bump (or a stale lockfile) downgrades one of these
 * pins back into a vulnerable range, this test fails loudly instead of the
 * vulnerability silently re-appearing in `node_modules`.
 *
 * Resolve through `node_modules` (not just `package.json`) so we assert
 * against the actually-installed version, not just the declared range.
 */

const require = createRequire(import.meta.url);

function installedVersion(pkg: string): { version: string; major: number; minor: number } {
  const pkgJsonPath = require.resolve(`${pkg}/package.json`);
  const meta = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version: string };
  const [major, minor] = meta.version.split(".").map(Number);
  return { version: meta.version, major: major ?? 0, minor: minor ?? 0 };
}

describe("security: dependency pins (regression)", () => {
  it("vitest is >= 4.1.0 — GHSA-5xrq-8626-4rwp / CVE-2026-47429", () => {
    // < 4.1.0 has a critical path-traversal + RCE via the Vitest UI server
    // (`/__vitest_attachment__` and `saveTestFile` + `rerun`). The kernel does
    // not enable the UI by default, but any developer who runs `vitest --ui`
    // or sets `api.host` would be vulnerable on a downgraded install. Keep
    // this pin >= 4.1.0 unconditionally.
    const { version, major, minor } = installedVersion("vitest");
    const safe = major > 4 || (major === 4 && minor >= 1);
    expect(
      safe,
      `vitest installed at ${version}; must be >= 4.1.0 (GHSA-5xrq-8626-4rwp).`,
    ).toBe(true);
  });
});
