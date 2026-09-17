import { useOnline } from "../lib/presence.ts";
import { Avatar } from "./Avatar.tsx";

/** Who is here right now; click a viewer to jump to what they are looking at. */
export function OnlineUsers({
  selfId,
  onOpenIssue,
}: {
  selfId: string;
  onOpenIssue: (id: string) => void;
}) {
  const online = useOnline();
  return (
    <div className="flex items-center justify-between gap-2 px-2">
      <span className="text-xs text-muted-foreground">{online.length} online</span>
      <span className="flex -space-x-1">
        {online.map((p) => (
          <button
            key={p.user_id}
            type="button"
            className="rounded-full disabled:cursor-default"
            disabled={!p.issue_id}
            onClick={() => p.issue_id && onOpenIssue(p.issue_id)}
          >
            <Avatar
              name={p.name}
              color={p.color}
              size="md"
              className="ring-sidebar"
              hint={`${p.name}${p.user_id === selfId ? " (you)" : ""}${p.issue_id ? " · viewing an issue" : ""}`}
            />
          </button>
        ))}
      </span>
    </div>
  );
}
