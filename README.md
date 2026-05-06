# training-app

Vanilla-JS PWA for the training subsystem. Reads from / writes to [`personal-api`](https://github.com/Jesse-vdR/personal_api). Live at https://training.jesselab.space/. Roadmap: [Jesse-vdR/Jesse#14](https://github.com/Jesse-vdR/Jesse/issues/14).

## Status

Phase 5 — installable PWA. `manifest.json`, `service-worker.js`, and 192/512 icons land. The SW pre-caches the app shell on install (best-effort) and goes network-first with cache fallback for everything else. `version.txt`, `/data/api_base.json`, and the SW itself are excluded from caching so deploys propagate. The rewrite ticket [#3](https://github.com/Jesse-vdR/training-app/issues/3) closes once this lands.

## Local dev

```bash
# Point the app at a local API. Edit but don't commit.
echo '{"api_base":"http://localhost:8000"}' > data/api_base.json

# Serve the static bundle.
python3 -m http.server 8001
open http://localhost:8001/
```

The `personal-api` service must be running locally (`make dev` in that repo) and `localhost:8001` must be in its `ALLOWED_REDIRECT_ORIGINS` for the auth flow.

## Deploy

`git push origin main` → GitHub Actions → SSH → `scripts/deploy.sh` on `jesse-prod`. The deploy step rsyncs the working tree to `/srv/web/training/repo/`, then publishes the static bundle to `/srv/web/training/site/` (served by nginx). Live target: https://training.jesselab.space/version.txt.

## VM contract

- `deploy` user; `/srv/web/training/{repo,site}` owned by `deploy:deploy`
- Sudoers: `deploy ALL=NOPASSWD: /bin/cp, /bin/cmp, /bin/systemctl, /usr/bin/journalctl, /usr/sbin/nginx, /bin/ln` (already in place from `personal-api`)
- nginx site config synced to `/etc/nginx/sites-available/training.jesselab.space`
- TLS: existing wildcard cert for `*.jesselab.space`

## GH Actions secrets

Reuses the same secrets as `personal-api`: `SSH_PRIVATE_KEY`, `SSH_HOST`, `SSH_USER`.

## Layout

```
index.html              app shell mount point + manifest / icon links
app.js                  bootstrap — config, /v1/me, today/project views, SW reg
style.css
manifest.json           PWA install metadata
service-worker.js       offline shell + cache-on-fetch
icon-192.png            home-screen icon (192×192)
icon-512.png            home-screen icon (512×512)
data/api_base.json      API base URL, edited at deploy time per env
nginx/                  nginx site config (synced to /etc/nginx/sites-available/)
scripts/deploy.sh       runs on VM after rsync
.github/workflows/      push-to-main pipeline
```
