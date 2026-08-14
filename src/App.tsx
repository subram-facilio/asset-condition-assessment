import { useEffect, useState } from "react";
import { useRoute } from "./lib/ui";
import Layout from "./components/Layout";
import { UserProvider } from "./context/UserContext";
import { Dashboard } from "./pages/Dashboard";
import { RunAssessment } from "./pages/RunAssessment";
import { AssetDetail } from "./pages/AssetDetail";
import { Register } from "./pages/Register";
import { Settings } from "./pages/Settings";

/** Resolve the hash route to a page. Kept out of the component so the mapping reads in one place. */
function routeTo(path: string) {
  const assetMatch = /^\/asset\/(\d+)/.exec(path);
  if (assetMatch) return <AssetDetail assetId={Number(assetMatch[1])} />;

  const runMatch = /^\/run\/(\d+)/.exec(path);
  if (runMatch) return <RunAssessment presetAssetId={Number(runMatch[1])} />;

  if (path.startsWith("/run")) return <RunAssessment />;
  if (path.startsWith("/register")) return <Register />;
  if (path.startsWith("/settings")) return <Settings />;
  return <Dashboard />;
}

export default function App() {
  const [, force] = useState(0);
  const { path } = useRoute();

  useEffect(() => {
    const onHash = () => force((n) => n + 1);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <UserProvider>
      <Layout>{routeTo(path)}</Layout>
    </UserProvider>
  );
}
