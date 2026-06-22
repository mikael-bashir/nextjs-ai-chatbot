#!/usr/bin/env bash
# One-time setup on the LunaNode VPS to enable preview deployments.
# Run as the deploy user (same one in SERVER_USER secret), not root.
# Takes ~2 minutes.
set -euo pipefail

DEPLOY_USER=$(whoami)

echo "==> Installing Caddy"
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
sudo apt-get update -q
sudo apt-get install -y caddy

echo "==> Configuring Caddyfile"
sudo tee /etc/caddy/Caddyfile > /dev/null << 'CADDY'
{
    # Replace with your email for Let's Encrypt notifications
    email admin@leak.competemath.com
}

# Production — proxies to the Docker container on port 3000
leak.competemath.com {
    reverse_proxy localhost:3000
}

# All preview subdomains — each PR adds a file under sites/
# Caddy auto-provisions a TLS cert on the first request (HTTP-01 ACME).
# This works because *.preview.leak.competemath.com is a wildcard DNS A record.
import /etc/caddy/sites/*.caddy
CADDY

sudo mkdir -p /etc/caddy/sites

echo "==> Granting ${DEPLOY_USER} permission to write Caddy sites and reload"
# Write Caddy sites dir without sudo
sudo chown -R "${DEPLOY_USER}:${DEPLOY_USER}" /etc/caddy/sites
sudo chmod 755 /etc/caddy/sites

# Reload Caddy without password (needed by GitHub Actions SSH step)
echo "${DEPLOY_USER} ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload caddy" \
  | sudo tee /etc/sudoers.d/caddy-preview-reload > /dev/null
sudo chmod 0440 /etc/sudoers.d/caddy-preview-reload

echo "==> Creating /opt/previews directory"
sudo mkdir -p /opt/previews
sudo chown -R "${DEPLOY_USER}:${DEPLOY_USER}" /opt/previews

echo "==> Starting Caddy"
sudo systemctl enable caddy
sudo systemctl restart caddy

echo ""
echo "Done. Next steps:"
echo ""
echo "  1. In Vercel DNS, add a wildcard A record:"
echo "        Name:  *.preview"
echo "        Value: $(curl -s ifconfig.me)"
echo "        TTL:   1 min (or Auto)"
echo ""
echo "  2. Add GitHub Actions secrets (Settings > Secrets and variables > Actions):"
echo "        STRIPE_SECRET_KEY_TEST"
echo "        STRIPE_WEBHOOK_SECRET_TEST"
echo "        STRIPE_PRICE_TOPUP_5_TEST"
echo "        STRIPE_PRICE_TOPUP_20_TEST"
echo "        STRIPE_PRICE_TOPUP_50_TEST"
echo "        STRIPE_PRICE_SUB_PRO_TEST"
echo "        (All the same secrets you have for production, plus the _TEST Stripe variants)"
echo ""
echo "  3. Make sure the GitHub repo has 'packages' write permission for Actions:"
echo "     Settings > Actions > General > Workflow permissions → Read and write"
echo ""
echo "  4. Open a PR — the preview-deploy.yml workflow does the rest."
