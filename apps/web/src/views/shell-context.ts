import { createContext, useContext } from "react";

/** What the shell offers the views: the mobile navigation toggle. */
export const ShellContext = createContext<{ openNav: () => void }>({ openNav: () => {} });

export function useShell() {
  return useContext(ShellContext);
}
