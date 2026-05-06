// Phase 2: auth bootstrap. Renders login or signed-in shell based on
// /v1/me. Today / project views land in subsequent phases.

async function loadConfig() {
  const res = await fetch("/data/api_base.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
  return res.json();
}

async function loadSha() {
  const res = await fetch("/version.txt", { cache: "no-store" });
  return res.ok ? (await res.text()).trim() : "dev";
}

async function getMe(apiBase) {
  const res = await fetch(`${apiBase}/v1/me`, { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/v1/me failed: ${res.status}`);
  return res.json();
}

async function logout(apiBase) {
  await fetch(`${apiBase}/v1/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "onclick") node.addEventListener("click", v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function meta(apiBase, sha) {
  return el("p", { class: "meta" }, apiBase, " · ", sha);
}

function renderLogin(root, { apiBase, sha }) {
  const next = encodeURIComponent(window.location.origin + "/");
  const href = `${apiBase}/v1/auth/google/login?next=${next}`;
  root.replaceChildren(
    el("section", { class: "auth-screen" },
      el("h1", {}, "training"),
      el("p", { class: "muted" },
        "Log today's plan, review the week."),
      el("a", { class: "btn-primary", href }, "Continue with Google"),
      meta(apiBase, sha),
    ),
  );
  root.removeAttribute("aria-busy");
}

function renderHome(root, { apiBase, sha, user }) {
  const onSignOut = async () => {
    await logout(apiBase);
    window.location.reload();
  };
  root.replaceChildren(
    el("header", { class: "topbar" },
      el("div", { class: "brand" }, "training"),
      el("div", { class: "user" },
        user.avatar_url ? el("img", { src: user.avatar_url, alt: "", class: "avatar" }) : null,
        el("span", { class: "user-name" }, user.name || user.email),
        el("button", { class: "btn-link", onclick: onSignOut }, "Sign out"),
      ),
    ),
    el("main", { class: "stage" },
      el("section", { class: "view-placeholder" },
        el("h2", {}, "Signed in"),
        el("p", { class: "muted" },
          "Today and project views land in the next phases."),
      ),
    ),
    el("footer", { class: "appfoot" }, meta(apiBase, sha)),
  );
  root.removeAttribute("aria-busy");
}

function renderError(root, message, { apiBase, sha } = {}) {
  root.replaceChildren(
    el("section", { class: "auth-screen" },
      el("h1", {}, "training"),
      el("p", { class: "muted" }, message),
      apiBase ? meta(apiBase, sha) : null,
    ),
  );
  root.removeAttribute("aria-busy");
}

async function bootstrap() {
  const root = document.getElementById("app");
  let config, sha;
  try {
    [config, sha] = await Promise.all([loadConfig(), loadSha()]);
  } catch (err) {
    renderError(root, `Failed to load config: ${err.message}`);
    return;
  }
  const apiBase = config.api_base;
  let user;
  try {
    user = await getMe(apiBase);
  } catch (err) {
    renderError(root, `Couldn't reach API: ${err.message}`, { apiBase, sha });
    return;
  }
  if (user) renderHome(root, { apiBase, sha, user });
  else renderLogin(root, { apiBase, sha });
}

bootstrap();
