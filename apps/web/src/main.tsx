import { ZeroProvider } from "@rocicorp/zero/react";
import { RouterProvider } from "@tanstack/react-router";
import { mutators, schema } from "@triage/schema";
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Login } from "./components/Login.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import {
  loadSession,
  saveSession,
  sessionFromToken,
  takeAuthFragment,
  verifySession,
  type Session,
} from "./lib/auth.ts";
import { applyTheme, loadTheme } from "./lib/theme.ts";
import { makeRouter } from "./router.tsx";
import "./index.css";

const CACHE_URL =
  (import.meta.env.VITE_ZERO_CACHE_URL as string | undefined) ?? "http://localhost:4848";

applyTheme(loadTheme());

const AUTH_ERRORS: Record<string, string> = {
  not_invited: "That GitHub account is not on the allowlist.",
  state: "The sign-in link expired. Try again.",
  exchange: "GitHub did not accept the sign-in. Try again.",
  config: "GitHub sign-in is not configured on this server.",
};

/** The OAuth callback lands here with `#session=…` or `#auth_error=…`; read it before rendering. */
const fragment = takeAuthFragment();

function Root() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [booting, setBooting] = useState(!!fragment.token);
  const logout = useCallback(() => {
    saveSession(null);
    setSession(null);
  }, []);
  // A stored token can outlive the server's secret; drop it rather than sync as nobody.
  const recheck = useCallback(
    (error?: unknown) => {
      if (!session) return;
      void verifySession(session).then((ok) => {
        if (ok === false) {
          console.warn("[auth] session rejected, signing out", error);
          logout();
        }
      });
    },
    [session, logout],
  );
  useEffect(() => {
    if (!fragment.token) return;
    void sessionFromToken(fragment.token).then((s) => {
      setSession(s);
      setBooting(false);
    });
  }, []);
  useEffect(() => recheck(), [recheck]);
  if (booting) return null;
  if (!session)
    return (
      <Login
        onLogin={setSession}
        error={fragment.error ? (AUTH_ERRORS[fragment.error] ?? fragment.error) : null}
        deniedLogin={fragment.error === "not_invited" ? (fragment.login ?? null) : null}
      />
    );
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
      <TooltipProvider delayDuration={300}>
        <Routed session={session} logout={logout} onSessionRejected={recheck} />
      </TooltipProvider>
    </ZeroProvider>
  );
}

/** One router per session; its context carries who is signed in and how to sign out. */
function Routed(props: {
  session: Session;
  logout: () => void;
  onSessionRejected: (error: unknown) => void;
}) {
  const router = useMemo(() => makeRouter(props), [props.session.token]);
  return <RouterProvider router={router} context={props} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
