/**
 * Where everything is, derived from the environment in one place. Locally nothing needs
 * setting: the defaults are the ports `vp run dev` uses. On Railway the platform's own
 * variables (PORT, RAILWAY_PUBLIC_DOMAIN, RAILWAY_PRIVATE_DOMAIN) fill in the public and
 * private addresses, so a deployment types only the secrets and the addresses of other
 * services. Everything here is pure and covered by tests.
 */

export type UrlEnv = Record<string, string | undefined>;

const read = (env: UrlEnv, name: string): string | undefined => env[name]?.trim() || undefined;
const strip = (s: string): string => s.replace(/\/+$/, "");

/** The port the API listens on: ours first, then the platform's, then the dev default. */
export function apiPort(env: UrlEnv): number {
  return Number(read(env, "API_PORT") ?? read(env, "PORT") ?? 3939);
}

/** Where browsers reach the app; the OAuth callback and post-login redirect are built on it. */
export function appUrl(env: UrlEnv): string {
  const set = read(env, "APP_URL");
  if (set) return strip(set);
  const railway = read(env, "RAILWAY_PUBLIC_DOMAIN");
  if (railway) return `https://${railway}`;
  return "http://localhost:5173";
}

/** Where browsers reach zero-cache; the web app asks the API for this instead of baking it in. */
export function zeroCacheUrl(env: UrlEnv): string {
  const set = read(env, "ZERO_CACHE_URL");
  if (set) return strip(set);
  return `http://localhost:${read(env, "ZERO_PORT") ?? 4848}`;
}

/** How the reviewer cell reaches this API: the private address on Railway, the Docker host alias locally. */
export function reviewCellApiUrl(env: UrlEnv): string {
  const set = read(env, "REVIEW_CELL_API_URL");
  if (set) return strip(set);
  const port = apiPort(env);
  const railway = read(env, "RAILWAY_PRIVATE_DOMAIN");
  if (railway) return `http://${railway}:${port}`;
  return `http://host.docker.internal:${port}`;
}

/**
 * How the reviewer cell reaches Phoenix. Locally the API sees Phoenix on a published port
 * and the cell sees it by its compose name; anywhere else the two share one address.
 */
export function reviewCellPhoenixUrl(env: UrlEnv, phoenixEndpoint: string | null): string {
  const set = read(env, "REVIEW_CELL_PHOENIX_URL");
  if (set) return strip(set);
  if (phoenixEndpoint && !isLocalUrl(phoenixEndpoint)) return phoenixEndpoint;
  return "http://phoenix:6006";
}

/** True for loopback and the Docker host alias: places only this machine can reach. */
export function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return ["localhost", "127.0.0.1", "[::1]", "::1", "host.docker.internal"].includes(host);
}
