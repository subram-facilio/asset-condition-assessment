import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { vibe } from "../lib/vibe";

/**
 * The signed-in Vibe user, resolved once at startup.
 *
 * Lifted out of App.tsx so the TopBar's profile menu and the Home greeting can read the name
 * without it being threaded through every page. `undefined` means still resolving; `null` means
 * the lookup failed (the app still renders — nothing here gates the data).
 */

export interface VibeUser {
  name?: string;
  email?: string;
}

interface UserContextValue {
  user: VibeUser | null | undefined;
  /** First word of the name, falling back to the email local-part, then "there". */
  firstName: string;
}

const UserContext = createContext<UserContextValue>({ user: undefined, firstName: "there" });

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<VibeUser | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    vibe
      .getCurrentUser()
      .then((u: any) => {
        if (!u) return vibe.login();
        if (active) setUser({ name: u?.user?.name, email: u?.user?.email });
      })
      .catch(() => {
        if (active) setUser(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const label = user?.name || user?.email?.split("@")[0] || "";
  const firstName = label.split(" ")[0] || "there";

  return <UserContext.Provider value={{ user, firstName }}>{children}</UserContext.Provider>;
}

export function useUser(): UserContextValue {
  return useContext(UserContext);
}
