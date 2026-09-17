import { useState } from "react";
import { devLogin, type Session } from "../lib/auth.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";

export function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onLogin(await devLogin(name.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

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
            Dev sign-in. The same name is the same user in every tab, so open two windows to see the
            multiplayer bits.
          </p>
        </div>
        <form onSubmit={submit} className="flex w-full flex-col gap-2">
          <Input
            autoFocus
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
          />
          {error && <p className="text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? "Signing in…" : "Continue"}
          </Button>
        </form>
      </div>
    </div>
  );
}
