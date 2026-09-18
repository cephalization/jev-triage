import { useQuery, useZero } from "@rocicorp/zero/react";
import { mutators, queries, ROLES, type Role } from "@triage/schema";
import { X } from "lucide-react";
import { useState } from "react";
import type { Session } from "../lib/auth.ts";
import { ago } from "../lib/format.ts";
import { Avatar } from "./Avatar.tsx";
import { Tag } from "./Marks.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

/**
 * Who may sign in. Admins from env are always allowed and cannot be removed here; everyone
 * else is on this list. Removing an invite stops the next sign-in, not a live session.
 */
export function People({
  session,
  adminLogins,
  now,
}: {
  session: Session;
  /** Logins granted by the server's ADMIN_GITHUB_LOGINS, for display. */
  adminLogins: readonly string[];
  now: number;
}) {
  const z = useZero();
  const [invites] = useQuery(queries.invites.all());
  const [users] = useQuery(queries.users.all());
  const nameOf = (id: string | null | undefined) =>
    id ? (users.find((u) => u.id === id)?.name ?? "an admin") : "an admin";
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState<string | null>(null);

  function add(e: React.FormEvent) {
    e.preventDefault();
    const l = login.trim().replace(/^@/, "");
    if (!l) return;
    setError(null);
    const r = z.mutate(mutators.invite.add({ login: l, role }));
    r.server.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    r.client.catch(() => {});
    setLogin("");
  }

  const members = users.filter((u) => u.login);
  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={add} className="flex items-center gap-2">
        <Input
          className="h-8"
          placeholder="GitHub login"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-label="GitHub login to invite"
        />
        <Select value={role} onValueChange={(v) => setRole(v as Role)}>
          <SelectTrigger size="sm" className="h-8 w-28" aria-label="Role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" disabled={!login.trim()}>
          Invite
        </Button>
      </form>
      {error && <p className="text-xs text-destructive">{error}</p>}

      <ul role="list" className="flex flex-col divide-y text-sm">
        {adminLogins.map((l) => (
          <li key={`env:${l}`} className="flex h-9 items-center gap-3">
            <span className="min-w-0 flex-1 truncate">@{l}</span>
            <Tag>admin</Tag>
            <span className="w-32 truncate text-xs text-muted-foreground">from server env</span>
            <span className="w-6" />
          </li>
        ))}
        {invites.map((i) => (
          <li key={i.login} className="flex h-9 items-center gap-3">
            <span className="min-w-0 flex-1 truncate">@{i.login}</span>
            <Tag>{i.role}</Tag>
            <span className="w-32 truncate text-xs text-muted-foreground">
              {i.accepted_at
                ? `joined ${ago(i.accepted_at, now)}`
                : `invited by ${nameOf(i.invited_by)}`}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove @${i.login}`}
              disabled={i.login === session.user.login.toLowerCase()}
              onClick={() => void z.mutate(mutators.invite.remove({ login: i.login }))}
            >
              <X />
            </Button>
          </li>
        ))}
        {invites.length === 0 && adminLogins.length === 0 && (
          <li className="py-2 text-xs text-muted-foreground">Nobody is invited yet.</li>
        )}
      </ul>

      {members.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">Signed in so far</h3>
          <ul role="list" className="flex flex-col divide-y text-sm">
            {members.map((u) => (
              <li key={u.id} className="flex h-9 items-center gap-3">
                <Avatar name={u.name} color={u.color} src={u.avatar_url} size="sm" />
                <span className="min-w-0 flex-1 truncate">
                  {u.name}
                  <span className="text-muted-foreground"> @{u.login}</span>
                </span>
                <Tag>{u.role}</Tag>
                <span className="w-32 truncate text-xs text-muted-foreground">
                  {u.last_login_at ? `seen ${ago(u.last_login_at, now)}` : ""}
                </span>
                <span className="w-6" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
