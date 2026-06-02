/**
 * Parsed form of a Calane Git registry URI:
 *   git+https://host/owner/repo.git#<ref>:<rootPath>
 *
 * - `repoUrl` is the clone URL with the `git+` prefix stripped.
 * - `ref` is a branch, tag, or commit SHA (defaults to "HEAD" when omitted).
 * - `rootPath` is the registry root directory inside the repo (defaults to "."),
 *   i.e. the directory containing `pipelines/`, `prompts/`, `schemas/`.
 */
export interface GitUri {
  repoUrl: string;
  ref: string;
  rootPath: string;
}

const GIT_PREFIX = "git+";

/** True when the string looks like a Calane Git registry URI. */
export function isGitUri(value: string): boolean {
  return value.startsWith(GIT_PREFIX);
}

/**
 * Parse `git+<url>#<ref>:<rootPath>`. The `#<ref>:<rootPath>` fragment is
 * optional; `<ref>` defaults to "HEAD" and `<rootPath>` to ".".
 */
export function parseGitUri(uri: string): GitUri {
  if (!isGitUri(uri)) {
    throw new Error(`Not a git registry URI (must start with "git+"): ${uri}`);
  }
  const withoutPrefix = uri.slice(GIT_PREFIX.length);
  const hashIndex = withoutPrefix.indexOf("#");
  if (hashIndex === -1) {
    return { repoUrl: withoutPrefix, ref: "HEAD", rootPath: "." };
  }
  const repoUrl = withoutPrefix.slice(0, hashIndex);
  const fragment = withoutPrefix.slice(hashIndex + 1);
  // Split ref and rootPath on the FIRST colon, so rootPaths may not contain ":".
  const colonIndex = fragment.indexOf(":");
  if (colonIndex === -1) {
    return { repoUrl, ref: fragment || "HEAD", rootPath: "." };
  }
  const ref = fragment.slice(0, colonIndex) || "HEAD";
  const rootPath = fragment.slice(colonIndex + 1) || ".";
  return { repoUrl, ref, rootPath };
}
