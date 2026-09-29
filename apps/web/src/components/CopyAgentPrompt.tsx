import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/button.tsx";
import { Textarea } from "./ui/textarea.tsx";

/** Clipboard errors retain the exact snapshot for manual copying, without changing triage state. */
export function CopyAgentPrompt({ buildPrompt }: { buildPrompt: () => string }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const [fallback, setFallback] = useState("");
  async function copy() {
    const prompt = buildPrompt();
    setStatus("copying");
    try {
      await navigator.clipboard.writeText(prompt);
      setFallback("");
      setStatus("copied");
    } catch {
      setFallback(prompt);
      setStatus("failed");
    }
  }
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void copy()}
          disabled={status === "copying"}
        >
          {status === "copied" ? <Check /> : <Copy />} Copy agent prompt
        </Button>
        <span role="status" className="text-xs text-muted-foreground">
          {status === "copied"
            ? "Copied. Paste into Claude Code or Codex."
            : status === "failed"
              ? "Clipboard unavailable. Select and copy the prompt below."
              : "Take this work into Claude Code or Codex."}
        </span>
      </div>
      {fallback && (
        <Textarea
          aria-label="Agent handoff prompt"
          readOnly
          value={fallback}
          onFocus={(e) => e.currentTarget.select()}
          className="mt-2 h-48 resize-y font-mono text-xs"
        />
      )}
    </div>
  );
}
