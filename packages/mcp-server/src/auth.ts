import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Token-based auth for the MCP surface. Mirrors the REST server's auth: tokens
 * come from the `CALANE_API_TOKEN` env var (primary) and an optional
 * `~/.calane/auth.toml` file (a token list). No user accounts, no OAuth — a
 * minimal token gate. The config file is sensitive (document `chmod 0600`).
 */

const AUTH_TOML_REL = join(".calane", "auth.toml");

export interface AuthConfig {
  envVar?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

/** Minimal `tokens = [...]` / `token = "..."` TOML reader (no TOML dependency). */
export function parseAuthToml(text: string): string[] {
  const stripComment = (line: string): string => {
    let inString = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inString = !inString;
      else if (ch === "#" && !inString) return line.slice(0, i);
    }
    return line;
  };
  const cleaned = text.split(/\r?\n/).map(stripComment).join("\n");
  const tokens: string[] = [];
  const arrayMatch = cleaned.match(/\btokens\s*=\s*\[([\s\S]*?)\]/);
  if (arrayMatch) {
    for (const m of arrayMatch[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      tokens.push(m[1]!.replace(/\\(["\\])/g, "$1"));
    }
  }
  const singleMatch = cleaned.match(/\btoken\s*=\s*"((?:[^"\\]|\\.)*)"/);
  if (singleMatch) tokens.push(singleMatch[1]!.replace(/\\(["\\])/g, "$1"));
  return tokens.filter((t) => t.length > 0);
}

export function loadValidTokens(config: AuthConfig = {}): Set<string> {
  const env = config.env ?? process.env;
  const envVar = config.envVar ?? "CALANE_API_TOKEN";
  const tokens = new Set<string>();
  const envToken = env[envVar];
  if (envToken) tokens.add(envToken);
  const configPath = config.configPath ?? join(homedir(), AUTH_TOML_REL);
  try {
    for (const t of parseAuthToml(readFileSync(configPath, "utf8"))) tokens.add(t);
  } catch {
    // optional file
  }
  return tokens;
}

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
 * MCP token auth. When no tokens are configured, auth is disabled (open). When
 * enabled, every tool call must carry a valid token in the request auth metadata
 * (`params._meta.token` or the transport `authInfo.token`).
 */
export class TokenAuth {
  private readonly valid: Set<string>;
  constructor(config: AuthConfig = {}) {
    this.valid = loadValidTokens(config);
  }
  get enabled(): boolean {
    return this.valid.size > 0;
  }
  verify(presented: string | null): boolean {
    if (!this.enabled) return true;
    return isValidToken(presented, this.valid);
  }
}

/**
 * Extract a token from an MCP CallTool request + handler extra. Checks the
 * transport-provided `authInfo.token` first, then the request's `_meta.token`.
 */
export function tokenFromMcp(
  params: { _meta?: Record<string, unknown> } | undefined,
  extra: { authInfo?: { token?: string } } | undefined,
): string | null {
  const fromAuthInfo = extra?.authInfo?.token;
  if (typeof fromAuthInfo === "string") return fromAuthInfo;
  const fromMeta = params?._meta?.token;
  if (typeof fromMeta === "string") return fromMeta;
  return null;
}
