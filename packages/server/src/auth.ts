import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Token-based auth for the REST + MCP surfaces. Tokens come from (in priority
 * order, unioned):
 *   1. the `CALANE_API_TOKEN` env var (a single token; the primary path), and
 *   2. an optional `~/.calane/auth.toml` config file (a list of tokens).
 *
 * No user accounts, no UI, no OAuth — this is the minimal token gate. The config
 * file is sensitive by definition and should be `chmod 0600`.
 */

const AUTH_TOML_REL = join(".calane", "auth.toml");

export interface AuthConfig {
  /** Override the env var name (default CALANE_API_TOKEN). */
  envVar?: string;
  /** Override the config-file path (default ~/.calane/auth.toml). */
  configPath?: string;
  /** Inject env (for tests); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Minimal parser for the auth.toml token list. Supports only what the auth file
 * needs — a top-level `tokens = ["...", "..."]` array of strings, plus a
 * single-token `token = "..."` form, and `#` line comments. This deliberately
 * avoids adding a TOML dependency for a one-key file.
 */
export function parseAuthToml(text: string): string[] {
  const stripComment = (line: string): string => {
    // Strip `#` comments that are not inside a string literal.
    let inString = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inString = !inString;
      else if (ch === "#" && !inString) return line.slice(0, i);
    }
    return line;
  };

  const tokens: string[] = [];
  // Join lines so a multi-line array still parses; comments removed per line.
  const cleaned = text.split(/\r?\n/).map(stripComment).join("\n");

  // tokens = [ "a", "b" ]
  const arrayMatch = cleaned.match(/\btokens\s*=\s*\[([\s\S]*?)\]/);
  if (arrayMatch) {
    for (const m of arrayMatch[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      tokens.push(unescapeTomlString(m[1]!));
    }
  }
  // token = "single"
  const singleMatch = cleaned.match(/\btoken\s*=\s*"((?:[^"\\]|\\.)*)"/);
  if (singleMatch) tokens.push(unescapeTomlString(singleMatch[1]!));

  return tokens.filter((t) => t.length > 0);
}

function unescapeTomlString(s: string): string {
  return s.replace(/\\(["\\])/g, "$1");
}

/** Load the set of valid tokens from env + optional config file. */
export function loadValidTokens(config: AuthConfig = {}): Set<string> {
  const env = config.env ?? process.env;
  const envVar = config.envVar ?? "CALANE_API_TOKEN";
  const tokens = new Set<string>();

  const envToken = env[envVar];
  if (envToken) tokens.add(envToken);

  const configPath = config.configPath ?? join(homedir(), AUTH_TOML_REL);
  try {
    const text = readFileSync(configPath, "utf8");
    for (const t of parseAuthToml(text)) tokens.add(t);
  } catch {
    // Config file is optional; absence/parse failure leaves the env token(s).
  }

  return tokens;
}

/** Extract a bearer token from an Authorization header value. */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

/** Constant-time membership check of a presented token against the valid set. */
export function isValidToken(presented: string | null, valid: Set<string>): boolean {
  if (!presented) return false;
  const presentedBuf = Buffer.from(presented);
  let ok = false;
  for (const candidate of valid) {
    const candidateBuf = Buffer.from(candidate);
    if (
      candidateBuf.length === presentedBuf.length &&
      timingSafeEqual(candidateBuf, presentedBuf)
    ) {
      ok = true;
    }
  }
  return ok;
}

/**
 * Token auth verifier. When no valid tokens are configured at all, auth is
 * DISABLED (open) — this preserves local/dev and the existing test setup that
 * does not set a token. When at least one token is configured, every protected
 * surface requires a matching bearer token.
 */
export class TokenAuth {
  private readonly valid: Set<string>;
  constructor(config: AuthConfig = {}) {
    this.valid = loadValidTokens(config);
  }
  /** True when at least one token is configured (auth enforced). */
  get enabled(): boolean {
    return this.valid.size > 0;
  }
  /** Verify a presented bearer token. Always true when auth is disabled. */
  verify(presented: string | null): boolean {
    if (!this.enabled) return true;
    return isValidToken(presented, this.valid);
  }
}
