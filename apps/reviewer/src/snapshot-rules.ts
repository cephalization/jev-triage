/**
 * What a repository snapshot keeps: source a reviewer might read, as text. Pure, so the rules
 * are testable outside the cell runtime.
 */

export const MAX_FILE_BYTES = 200 * 1024;
const SKIP_DIRS =
  /(^|\/)(node_modules|\.git|dist|build|out|vendor|__pycache__|\.next|target|coverage|\.venv)\//;
const SKIP_FILES =
  /\.(png|jpe?g|gif|webp|ico|svg|pdf|woff2?|ttf|eot|otf|zip|gz|tgz|jar|wasm|mp[34]|mov|snap|min\.js|min\.css|map|lock|lockb|pyc|class|so|dylib|dll|exe|bin|parquet|sqlite|db)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum)$/i;

export function wanted(path: string, size: number): boolean {
  if (size === 0 || size > MAX_FILE_BYTES) return false;
  if (SKIP_DIRS.test(path) || SKIP_FILES.test(path)) return false;
  return true;
}

/** No NUL byte in the first 8 KB: good enough to tell source from a binary that slipped past the rules. */
export function isText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i += 1) if (bytes[i] === 0) return false;
  return true;
}

/** GitHub tarballs wrap everything in `owner-repo-sha/`. */
export function stripRoot(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}
