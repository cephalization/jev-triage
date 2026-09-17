import { ZeroProvider } from "@rocicorp/zero/react";
import { mutators, schema } from "@triage/schema";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { Login } from "./components/Login.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { loadSession, saveSession, type Session } from "./lib/auth.ts";
import "./index.css";

const CACHE_URL =
  (import.meta.env.VITE_ZERO_CACHE_URL as string | undefined) ?? "http://localhost:4848";

function Root() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  if (!session) return <Login onLogin={setSession} />;
  return (
    <ZeroProvider
      cacheURL={CACHE_URL}
      userID={session.user.userID}
      auth={session.token}
      context={session.user}
      schema={schema}
      mutators={mutators}
      kvStore="idb"
    >
      <TooltipProvider>
        <App
          session={session}
          onLogout={() => {
            saveSession(null);
            setSession(null);
          }}
        />
      </TooltipProvider>
    </ZeroProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
