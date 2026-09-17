import { cn } from "cn";
import { initials } from "../lib/format.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

export function Avatar({
  name,
  color,
  size = "sm",
  hint,
  className,
}: {
  name: string;
  color: string;
  size?: "xs" | "sm" | "md";
  hint?: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white ring-2 ring-background",
            size === "xs" && "size-4 text-[8px]",
            size === "sm" && "size-5 text-[9px]",
            size === "md" && "size-6 text-2xs",
            className,
          )}
          style={{ backgroundColor: color }}
          aria-label={name}
        >
          {initials(name)}
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint ?? name}</TooltipContent>
    </Tooltip>
  );
}

export function AvatarStack({
  people,
  max = 3,
  size = "sm",
}: {
  people: readonly { key: string; name: string; color: string; hint?: string }[];
  max?: number;
  size?: "xs" | "sm" | "md";
}) {
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  return (
    <span className="flex -space-x-1">
      {shown.map((p) => (
        <Avatar key={p.key} name={p.name} color={p.color} hint={p.hint} size={size} />
      ))}
      {people.length > max && (
        <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-[9px] ring-2 ring-background">
          +{people.length - max}
        </span>
      )}
    </span>
  );
}
