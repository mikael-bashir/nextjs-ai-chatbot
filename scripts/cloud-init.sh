#!/bin/bash
# Paste this into LunaNode → Instance → User Data.
# Runs automatically as root on every reprovision — no manual SSH needed.
set -euo pipefail

DEPLOY_USER="ubuntu"

# ── Docker ────────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker "$DEPLOY_USER"

# ── Caddy ─────────────────────────────────────────────────────────────────────
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
  apt-get update -q && apt-get install -y caddy
fi

# ── Stripe CLI ────────────────────────────────────────────────────────────────
if ! command -v stripe >/dev/null 2>&1; then
  curl -fsSL https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public \
    | gpg --dearmor \
    | tee /usr/share/keyrings/stripe.gpg > /dev/null
  echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" \
    | tee /etc/apt/sources.list.d/stripe.list > /dev/null
  apt-get update -q && apt-get install -y stripe
fi

# ── Directories & permissions ─────────────────────────────────────────────────
mkdir -p /etc/caddy/sites /opt/previews
chown -R "$DEPLOY_USER:$DEPLOY_USER" /etc/caddy/sites /opt/previews
chmod 755 /etc/caddy/sites /opt/previews

# ── Caddyfile ─────────────────────────────────────────────────────────────────
cat > /etc/caddy/Caddyfile << 'CADDY'
{
    email admin@leak.competemath.com
}

leak.competemath.com {
    reverse_proxy localhost:3000 {
        header_up X-Forwarded-Host {host}
        header_up X-Forwarded-Proto {scheme}
    }
}

import /etc/caddy/sites/*.caddy
CADDY

# ── Sudoers ───────────────────────────────────────────────────────────────────
# Deploy workflow needs passwordless reload + apt-get for Stripe CLI installs
cat > /etc/sudoers.d/deploy-preview << SUDOERS
$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload caddy
$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/bin/apt-get
SUDOERS
chmod 0440 /etc/sudoers.d/deploy-preview

# ── Start Caddy ───────────────────────────────────────────────────────────────
systemctl enable caddy
systemctl restart caddy
