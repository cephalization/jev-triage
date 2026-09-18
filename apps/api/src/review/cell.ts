/**
 * The reviewer cell (apps/reviewer, celld). Every guided review runs there: it holds the
 * repository snapshot and the agent's tools, and prices every call. REVIEW_CELL_URL names it;
 * the provider key travels in each request body, so keep the cell on loopback or behind
 * REVIEWER_TOKEN.
 */

export interface Cell {
  url: string;
  token: string | null;
}

export interface Snapshot {
  owner: string;
  repo: string;
  sha: string;
}

export function cellHeaders(cell: Cell): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(cell.token ? { "x-reviewer-token": cell.token } : {}),
  };
}

/** True when the cell answers its health check. */
export async function cellReachable(
  cell: { url: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${cell.url.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Load the repository at the head into the cell; throws with the cell's reason when it cannot. */
export async function loadSnapshotInCell(
  cell: Cell,
  repoId: string,
  sha: string,
  github: { token: string | null; apiBase: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Snapshot> {
  const [owner, repo] = repoId.split("/") as [string, string];
  const res = await fetchImpl(`${cell.url}/snapshots/${owner}/${repo}/${sha}`, {
    method: "POST",
    headers: cellHeaders(cell),
    body: JSON.stringify({ owner, repo, sha, apiBase: github.apiBase, token: github.token }),
    signal: AbortSignal.timeout(180_000),
  });
  const s = (await res.json().catch(() => ({}))) as { status?: string; error?: string | null };
  if (s.status !== "ready")
    throw new Error(`repository snapshot ${s.status ?? res.status}: ${s.error ?? "no detail"}`);
  return { owner, repo, sha };
}
