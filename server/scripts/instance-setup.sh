#!/bin/bash
# Blueberry Browser — One-time setup for the GCP Firecracker instance.
# Run ON the instance after SSH-ing in:
#   gcloud compute ssh firecracker-dev --zone=us-central1-b
#   bash server/scripts/instance-setup.sh
set -euo pipefail

echo "==> Verifying KVM support"
if [ ! -e /dev/kvm ]; then
  echo "ERROR: /dev/kvm not found. Nested virtualization is not enabled on this instance."
  exit 1
fi
echo "KVM is available"

echo "==> Installing system dependencies"
sudo apt-get update
sudo apt-get install -y curl wget docker.io e2fsprogs util-linux jq

echo "==> Adding user to docker and kvm groups"
sudo usermod -aG docker "$USER"
sudo usermod -aG kvm "$USER"
echo "    IMPORTANT: Firecracker needs /dev/kvm. After this script, log out and SSH in"
echo "    again (or run: newgrp kvm) so the kvm group applies to your session."

echo "==> Installing Firecracker"
ARCH=$(uname -m)
RELEASE_URL="https://github.com/firecracker-microvm/firecracker/releases"
LATEST=$(basename "$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${RELEASE_URL}/latest")")
echo "Installing Firecracker ${LATEST}"
curl -L "${RELEASE_URL}/download/${LATEST}/firecracker-${LATEST}-${ARCH}.tgz" | tar -xz
sudo mv "release-${LATEST}-${ARCH}/firecracker-${LATEST}-${ARCH}" /usr/local/bin/firecracker
sudo mv "release-${LATEST}-${ARCH}/jailer-${LATEST}-${ARCH}" /usr/local/bin/jailer
rm -rf "release-${LATEST}-${ARCH}"
firecracker --version

echo "==> Downloading Firecracker-compatible kernel"
sudo mkdir -p /opt/firecracker
curl -fsSL -o /tmp/vmlinux.bin \
  https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/kernels/vmlinux.bin
sudo mv /tmp/vmlinux.bin /opt/firecracker/vmlinux.bin

echo "==> Installing Node.js 20"
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo ""
echo "==> Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Log out and back in (so docker/kvm group changes take effect)"
echo "  2. Clone or copy the repo, then run:"
echo "       bash server/scripts/build-rootfs.sh"
echo "  3. Then:"
echo "       cd server && npm install && npm start"
