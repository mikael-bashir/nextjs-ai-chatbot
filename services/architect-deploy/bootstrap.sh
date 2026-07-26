#!/usr/bin/env bash
# One-shot bootstrap for the Leak Architect stack on a fresh Oracle Always
# Free VM (Ubuntu 22.04/24.04 aarch64). Run as a sudo-capable user:
#
#   git clone <your repo> leak && cd leak/services/architect-deploy
#   bash bootstrap.sh
#
# First build is the slow part: the Mathlib olean cache (~3-5 GB download)
# plus compiling LeanArchitect + the REPL. Expect 30-60 min on 2 OCPUs.
set -euo pipefail

echo "== [1/5] docker =="
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "NOTE: log out/in (or 'newgrp docker') for group membership to apply."
fi

echo "== [2/5] swap (8G — Lean daemons burst hard) =="
if ! sudo swapon --show | grep -q swapfile; then
  sudo fallocate -l 8G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

echo "== [3/5] open service ports in the VM firewall =="
# Oracle images ship restrictive iptables; the subnet security list must ALSO
# allow 8011/8012/8014 (or put Caddy on 443 instead and open only that).
for p in 8011 8012 8014; do
  sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || \
    sudo iptables -I INPUT -p tcp --dport "$p" -j ACCEPT
done
sudo netfilter-persistent save 2>/dev/null || true

echo "== [4/5] build shared Lean base (slow, once) =="
sudo docker build -t leak-lean-base ../leak-lean-base

echo "== [5/5] build + start the stack =="
sudo docker compose up -d --build

echo "== waiting for health =="
sleep 5
for port in 8011 8012 8014; do
  curl -fsS "http://localhost:${port}/health" && echo " <- :${port} OK" || echo " :${port} not ready yet (XII warms Lean daemons for ~2 min after start)"
done

echo
echo "Done. From the bridge machine, set:"
echo "  LEAK_XI_URL=http://<vm-ip>:8011"
echo "  LEAK_XII_URL=http://<vm-ip>:8012"
echo "  LEAK_XIV_URL=http://<vm-ip>:8014"
