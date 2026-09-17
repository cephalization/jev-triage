import { useEffect, useState } from "react";
import {
  fetchAuthInfo,
  GITHUB_LOGIN_URL,
  LoginError,
  tokenLogin,
  type AuthInfo,
  type Session,
} from "../lib/auth.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";

/** Sign-in: GitHub OAuth for people, a token field for agents, tests and emulator users. */
export function Login({
  onLogin,
  error: initialError = null,
  deniedLogin = null,
}: {
  onLogin: (s: Session) => void;
  /** An error carried back from the OAuth callback, if any. */
  error?: string | null;
  /** The GitHub login that was refused, when the error is about the allowlist. */
  deniedLogin?: string | null;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [denied, setDenied] = useState<string | null>(deniedLogin);
  const [info, setInfo] = useState<AuthInfo | null>(null);
  useEffect(() => {
    void fetchAuthInfo().then(setInfo);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setError(null);
    setDenied(null);
    try {
      onLogin(await tokenLogin(token.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (err instanceof LoginError && err.login) setDenied(err.login);
    } finally {
      setBusy(false);
    }
  }

  const githubReady = info?.github ?? true;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4 text-sm antialiased">
      <div className="flex w-full max-w-xs flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <svg width={20} height={20} viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3.5 8.5l3 3L12.5 5"
                stroke="currentColor"
                strokeWidth={2}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <h1 className="text-lg font-semibold tracking-tight text-balance">
            Sign in to typeful-triage
          </h1>
          <p className="text-center text-muted-foreground text-pretty">
            Invite only. Sign in with the GitHub account an admin invited
            {info?.emulated ? ", against the local GitHub emulator" : ""}.
          </p>
        </div>

        <div className="flex w-full flex-col gap-3">
          <Button asChild disabled={!githubReady}>
            <a href={githubReady ? GITHUB_LOGIN_URL : undefined} aria-disabled={!githubReady}>
              Continue with GitHub
            </a>
          </Button>
          {info && !info.github && (
            <p className="text-center text-xs text-muted-foreground text-pretty">
              GitHub sign-in is not configured on this server (no client id). Use a token below.
            </p>
          )}

          {denied && (
            <p className="rounded-md border px-3 py-2 text-xs text-pretty">
              <span className="font-medium">@{denied}</span> is not on the allowlist. Ask an admin
              to invite you, then try again.
            </p>
          )}
          {error && !denied && <p className="text-center text-xs text-destructive">{error}</p>}

          <details className="group text-xs" open={info ? !info.github : false}>
            <summary className="cursor-pointer text-center text-muted-foreground hover:text-foreground">
              Use a GitHub token instead
            </summary>
            <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
              <Input
                placeholder={info?.emulated ? "Emulator token" : "Personal access token"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="submit" variant="secondary" disabled={busy || !token.trim()}>
                {busy ? "Signing in…" : "Sign in with token"}
              </Button>
              <p className="text-center text-muted-foreground text-pretty">
                The token is used once to look up your GitHub login and is not stored.
              </p>
            </form>
          </details>
        </div>
      </div>
    </div>
  );
}
