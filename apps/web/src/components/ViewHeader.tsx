import { Menu, Search } from "lucide-react";
import { useShell } from "../views/shell-context.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

export const FILTER_TRIGGER =
  "h-7 gap-1 border-transparent bg-transparent px-2 text-xs shadow-none hover:bg-accent dark:bg-transparent dark:hover:bg-accent";
export const TOGGLE =
  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground data-active:bg-accent data-active:text-foreground";

/** The 40px bar every view starts with: menu on small screens, title, a count, then controls. */
export function ViewHeader({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children?: React.ReactNode;
}) {
  const { openNav } = useShell();
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
      <Button
        variant="ghost"
        size="icon-xs"
        className="lg:hidden"
        onClick={openNav}
        aria-label="Open navigation"
      >
        <Menu />
      </Button>
      <h1 className="pl-1 font-medium">{title}</h1>
      {count !== undefined && (
        <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
      )}
      <span className="flex-1" />
      {children}
    </header>
  );
}

/** Search box wired to the URL; `/` focuses it from anywhere. */
export function SearchBox({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        data-search
        className="h-7 w-44 border-transparent bg-transparent pl-7 text-xs shadow-none hover:bg-accent focus-visible:border-input focus-visible:bg-background focus-visible:ring-0 dark:bg-transparent"
        placeholder="Search"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** Two-or-three way switch in the compact header style. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      className="inline-flex h-6 shrink-0 items-center rounded-md border p-0.5 text-xs"
      role="radiogroup"
      aria-label={label}
    >
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          data-active={value === v || undefined}
          onClick={() => onChange(v)}
          className="h-5 rounded-sm px-2 text-muted-foreground hover:text-foreground data-active:bg-accent data-active:text-foreground"
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** The 32px strip under the header that explains the list and holds its layout switches. */
export function Strip({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-20 flex h-8 items-center gap-2 border-b bg-background px-4 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export function KeyHelp({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="kbd ml-1 cursor-default" tabIndex={0}>
          ?
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="text-left">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {rows.map(([k, what]) => (
            <span key={k} className="contents">
              <span>{k}</span>
              <span>{what}</span>
            </span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export const LIST_KEYS = [
  ["j / k", "move"],
  ["Esc", "close"],
  ["/", "search"],
  ["g then t u p r s", "switch view"],
] as const;

export const ISSUE_KEYS = [
  ["j / k", "move"],
  ["Esc", "close"],
  ["a", "looks right, done"],
  ["c", "claim / release"],
  ["x", "done / reopen"],
  ["1–6", "set category"],
  ["/", "search"],
  ["g then t u p r s", "switch view"],
] as const;
