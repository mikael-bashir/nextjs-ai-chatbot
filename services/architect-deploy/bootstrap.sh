#!/usr/bin/env bash
# One-shot bootstrap for the Leak Architect stack on a fresh Oracle Cloud VM
# (VM.Standard.A1.Flex, aarch64). Handles BOTH images OCI offers by default:
#   * Ubuntu 22.04/24.04  -> apt + iptables/netfilter-persistent
#   * Oracle Linux 9      -> dnf + firewalld
#
# Usage, as a sudo-capable user (opc on Oracle Linux, ubuntu on Ubuntu):
#   git clone <your repo> leak && cd leak/services/architect-deploy
#   bash bootstrap.sh
#
# First build is the slow part: the Mathlib olean cache (~3-5 GB download)
# plus compiling LeanArchitect + the REPL. Expect 30-60 min on 2 OCPUs.
set -euo pipefail

if [ -r /etc/os-release ]; then . /etc/os-release; else ID=unknown; fi
case "${ID:-}" in
  ubuntu|debian) DISTRO=deb ;;
  ol|rhel|centos|almalinux|rocky|fedora) DISTRO=rpm ;;
  *) echo "Unrecognised distro '${ID:-?}' — assuming rpm (Oracle Linux)."; DISTRO=rpm ;;
esac
echo "== detected: ${PRETTY_NAME:-$ID} (${DISTRO}) on $(uname -m) =="

echo "== [0/5] prerequisites =="
# Ubuntu *Minimal* (the OCI default aarch64 image) ships without git, and
# without iptables-persistent — which means firewall rules silently vanish on
# reboot. Install both non-interactively so the persistent-save later works.
if [ "$DISTRO" = deb ]; then
  export DEBIAN_FRONTEND=noninteractive
  echo 'iptables-persistent iptables-persistent/autosave_v4 boolean true' | sudo debconf-set-selections
  echo 'iptables-persistent iptables-persistent/autosave_v6 boolean true' | sudo debconf-set-selections
  sudo -E apt-get update -qq
  sudo -E apt-get install -y -qq git curl ca-certificates iptables-persistent
else
  sudo dnf install -y -q git curl ca-certificates
fi

echo "== [1/5] docker =="
if ! command -v docker >/dev/null 2>&1; then
  if [ "$DISTRO" = deb ]; then
    curl -fsSL https://get.docker.com | sudo sh
  else
    # get.docker.com does not officially support Oracle Linux; use the
    # CentOS repo, which is RHEL-compatible and works on OL9 aarch64.
    sudo dnf install -y dnf-plugins-core
    sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    sudo systemctl enable --now docker
  fi
  sudo usermod -aG docker "$USER" || true
  echo "NOTE: log out/in (or run 'newgrp docker') for group membership to apply."
fi
sudo systemctl enable --now docker 2>/dev/null || true

echo "== [2/5] swap (8G — Lean daemons burst hard) =="
if ! sudo swapon --show | grep -q swapfile; then
  sudo fallocate -l 8G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=8192
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "== [3/5] open service ports in the VM firewall =="
# NOTE: this is only the HOST firewall. You must ALSO add an ingress rule for
# TCP 8011-8014 to the subnet's Security List in the OCI console, or nothing
# reaches the box.
if [ "$DISTRO" = deb ]; then
  for p in 8011 8012 8014; do
    sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || \
      sudo iptables -I INPUT -p tcp --dport "$p" -j ACCEPT
  done
  sudo netfilter-persistent save 2>/dev/null || true
else
  if systemctl is-active --quiet firewalld; then
    for p in 8011 8012 8014; do
      sudo firewall-cmd --permanent --add-port=${p}/tcp
    done
    sudo firewall-cmd --reload
  else
    for p in 8011 8012 8014; do
      sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || \
        sudo iptables -I INPUT -p tcp --dport "$p" -j ACCEPT
    done
    sudo service iptables save 2>/dev/null || true
  fi
fi

echo "== [4/5] build shared Lean base (slow, once) =="
sudo docker build -t leak-lean-base ../leak-lean-base

echo "== [5/5] build + start the stack =="
sudo docker compose up -d --build

echo "== waiting for health =="
sleep 5
for port in 8011 8012 8014; do
  curl -fsS "http://localhost:${port}/health" && echo " <- :${port} OK" \
    || echo " :${port} not ready yet (XII warms its Lean daemon for ~2 min after start)"
done

IP=$(curl -fsS ifconfig.me 2>/dev/null || echo "<vm-ip>")
echo
echo "Done. On your laptop, start the bridge with:"
echo "  LEAK_XI_URL=http://${IP}:8011"
echo "  LEAK_XII_URL=http://${IP}:8012"
echo "  LEAK_XIV_URL=http://${IP}:8014"
