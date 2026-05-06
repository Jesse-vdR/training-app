// Phase 1 bootstrap: load config, stamp the page with API base + deployed SHA.
// Auth + real views land in subsequent phases.

async function loadConfig() {
  const res = await fetch("/data/api_base.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
  return res.json();
}

async function loadSha() {
  const res = await fetch("/version.txt", { cache: "no-store" });
  return res.ok ? (await res.text()).trim() : "dev";
}

(async () => {
  const [config, sha] = await Promise.all([loadConfig(), loadSha()]);
  document.getElementById("api-base").textContent = config.api_base;
  document.getElementById("sha").textContent = sha;
})();
