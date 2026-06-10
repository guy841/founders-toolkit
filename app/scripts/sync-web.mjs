// Copies the Helm web app (index.html + tools/) into app/www so Capacitor can
// bundle it into the native app. The web assets stay at the repo root (which is
// also what GitHub Pages serves), so there's a single source of truth.
import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const repoRoot = join(appRoot, "..");
const www = join(appRoot, "www");

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });

cpSync(join(repoRoot, "index.html"), join(www, "index.html"));
cpSync(join(repoRoot, "privacy.html"), join(www, "privacy.html"));
cpSync(join(repoRoot, "manifest.webmanifest"), join(www, "manifest.webmanifest"));
cpSync(join(repoRoot, "sw.js"), join(www, "sw.js"));
cpSync(join(repoRoot, "tools"), join(www, "tools"), { recursive: true });
cpSync(join(repoRoot, "fonts"), join(www, "fonts"), { recursive: true });
cpSync(join(repoRoot, "icons"), join(www, "icons"), { recursive: true });

if (!existsSync(join(www, "index.html"))) {
  console.error("sync-web: failed to copy index.html");
  process.exit(1);
}
console.log("sync-web: copied index.html + tools/ into app/www");
