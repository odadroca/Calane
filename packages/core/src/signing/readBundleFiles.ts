import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * Read every regular file under a bundle directory into a path→content map,
 * using POSIX-style forward-slash relative paths (so hashing is stable across
 * platforms). Used by `verify-bundle` to recompute the canonical bundle hash.
 */
export async function readBundleFiles(bundlePath: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const rel = relative(bundlePath, full).split(sep).join("/");
        files[rel] = await readFile(full, "utf8");
      }
    }
  };
  await walk(bundlePath);
  return files;
}
