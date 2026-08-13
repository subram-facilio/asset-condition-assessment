import { useEffect, useState } from "react";
import { vibe } from "./lib/vibe";
import { useRoute } from "./lib/ui";
import { Dashboard } from "./pages/Dashboard";
import { RunAssessment } from "./pages/RunAssessment";
import { AssetDetail } from "./pages/AssetDetail";
import { Register } from "./pages/Register";
import { Settings } from "./pages/Settings";

const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/run", label: "Run assessment" },
  { to: "/register", label: "Condition register" },
  { to: "/settings", label: "Settings" },
];

export default function App() {
  const [, force] = useState(0);
  const { path } = useRoute();
  const [user, setUser] = useState<any>(undefined);

  useEffect(() => {
    const onHash = () => force((n) => n + 1);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    vibe
      .getCurrentUser()
      .then((u: any) => {
        if (!u) return vibe.login();
        setUser(u);
      })
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) {
    return (
      <div className="app">
        <div className="center">Signing you in…</div>
      </div>
    );
  }

  const assetMatch = /^\/asset\/(\d+)/.exec(path);
  const runMatch = /^\/run\/(\d+)/.exec(path);

  let page = <Dashboard />;
  if (assetMatch) page = <AssetDetail assetId={Number(assetMatch[1])} />;
  else if (runMatch) page = <RunAssessment presetAssetId={Number(runMatch[1])} />;
  else if (path.startsWith("/run")) page = <RunAssessment />;
  else if (path.startsWith("/register")) page = <Register />;
  else if (path.startsWith("/settings")) page = <Settings />;

  const activeTop = path.startsWith("/asset") ? "/register" : path.startsWith("/run") ? "/run" : path;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">CA</span>
          <span>Condition Assessment</span>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <a key={n.to} href={`#${n.to}`} className={activeTop === n.to ? "on" : ""}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="who">{user?.user?.name || user?.user?.email || ""}</div>
      </header>
      <main className="main">{page}</main>
    </div>
  );
}
