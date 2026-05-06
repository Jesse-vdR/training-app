#!/usr/bin/env bash
# Runs on jesse-prod as the `deploy` user. Invoked over SSH by GitHub
# Actions after the runner has rsync'd the working tree to
# /srv/web/training/repo/.
#
# Idempotent: safe to re-run by hand for debugging.

set -euo pipefail

REPO_DIR=/srv/web/training/repo
SITE_DIR=/srv/web/training/site
HEALTH_URL=https://training.jesselab.space/version.txt

cd "$REPO_DIR"

# 1. Sync nginx site if it changed.
if ! sudo cmp -s nginx/training.jesselab.space.conf /etc/nginx/sites-available/training.jesselab.space; then
    sudo cp nginx/training.jesselab.space.conf /etc/nginx/sites-available/training.jesselab.space
    sudo ln -sf /etc/nginx/sites-available/training.jesselab.space /etc/nginx/sites-enabled/training.jesselab.space
    sudo nginx -t
    sudo systemctl reload nginx
fi

# 2. Publish the static bundle. Atomic-ish via rsync --delete into the
#    served directory; nginx serves a request from one or the other,
#    never a half-written tree.
mkdir -p "$SITE_DIR"
rsync -a --delete \
    --exclude '.git' \
    --exclude '.github' \
    --exclude 'nginx' \
    --exclude 'scripts' \
    --exclude 'README.md' \
    "$REPO_DIR"/ "$SITE_DIR"/

# 3. Health check — fetch the SHA stamp through nginx.
for i in 1 2 3 4 5; do
    if curl -fsS "$HEALTH_URL" > /dev/null; then
        echo "deploy ok"
        exit 0
    fi
    sleep 1
done

echo "health check failed" >&2
sudo journalctl -u nginx --no-pager -n 30 >&2 || true
exit 1
