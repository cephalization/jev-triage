import { cn } from "cn";
import { useState } from "react";
import { initials } from "../lib/format.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/** A person: their GitHub picture when we have one, initials on their color otherwise. */
export function Avatar({
  name,
  color,
  src,
  size = "sm",
  hint,
  className,
}: {
  name: string;
  color: string;
  src?: string | null;
  size?: "xs" | "sm" | "md";
  hint?: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const showImage = !!src && !broken;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium text-white ring-2 ring-background",
            size === "xs" && "size-4 text-[8px]",
            size === "sm" && "size-5 text-[9px]",
            size === "md" && "size-6 text-2xs",
            className,
          )}
          style={showImage ? undefined : { backgroundColor: color }}
          aria-label={name}
        >
          {showImage ? (
            <img
              src={src}
              alt=""
              className="size-full object-cover"
              onError={() => setBroken(true)}
            />
          ) : (
            initials(name)
          )}
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
  className,
}: {
  people: readonly {
    key: string;
    name: string;
    color: string;
    src?: string | null;
    hint?: string;
  }[];
  max?: number;
  size?: "xs" | "sm" | "md";
  className?: string;
}) {
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  return (
    <span className={cn("flex -space-x-1", className)}>
      {shown.map((p) => (
        <Avatar key={p.key} name={p.name} color={p.color} src={p.src} hint={p.hint} size={size} />
      ))}
      {people.length > max && (
        <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-[9px] ring-2 ring-background">
          +{people.length - max}
        </span>
      )}
    </span>
  );
}
