#!/bin/bash
# Blueberry Browser — Build Firecracker rootfs images.
# Run ON the GCP instance after instance-setup.sh has completed.
#
# Produces:
#   /opt/firecracker/rootfs-python.ext4  (Python 3.11 + numpy + pandas)
#   /opt/firecracker/rootfs-node.ext4    (Node.js 20)
#
# Both images contain /opt/agent/agent.sh and /init so Firecracker can boot
# directly into the agent with:  boot_args="init=/init ..."
set -euo pipefail

ROOTFS_DIR="/opt/firecracker"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_SRC="$SCRIPT_DIR/../vm-agent/agent.sh"
MNT="/mnt/rootfs"

if [ ! -f "$AGENT_SRC" ]; then
  echo "ERROR: agent.sh not found at $AGENT_SRC"
  exit 1
fi

sudo mkdir -p "$ROOTFS_DIR" "$MNT"

# ---------------------------------------------------------------------------
# Helper: take a Docker image name, export it into an ext4 file, inject agent
# Usage: build_image <docker_image_tag> <Dockerfile_contents> <ext4_size_mb> <output_name>
# ---------------------------------------------------------------------------
build_image() {
  local TAG="$1"
  local DOCKERFILE="$2"
  local SIZE_MB="$3"
  local OUTPUT="$4"
  local CONTAINER="rfs-tmp-$$"

  echo ""
  echo "===> Building Docker image: $TAG"
  echo "$DOCKERFILE" | docker build -t "$TAG" -f - /tmp

  echo "===> Exporting filesystem"
  docker rm -f "$CONTAINER" 2>/dev/null || true
  docker create --name "$CONTAINER" "$TAG"
  docker export "$CONTAINER" > /tmp/rootfs-export.tar
  docker rm "$CONTAINER"

  echo "===> Creating ${SIZE_MB}MB ext4 image"
  dd if=/dev/zero of="/tmp/$OUTPUT" bs=1M count="$SIZE_MB" status=progress
  mkfs.ext4 "/tmp/$OUTPUT"

  sudo mount -o loop "/tmp/$OUTPUT" "$MNT"
  sudo tar -xf /tmp/rootfs-export.tar -C "$MNT"

  # Inject the VM agent
  sudo mkdir -p "$MNT/opt/agent" "$MNT/workspace"
  sudo cp "$AGENT_SRC" "$MNT/opt/agent/agent.sh"
  sudo chmod +x "$MNT/opt/agent/agent.sh"

  # Create /init — minimal init that mounts virtual filesystems then execs the agent
  sudo tee "$MNT/init" > /dev/null <<'INITEOF'
#!/bin/sh
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
mkdir -p /workspace
exec /opt/agent/agent.sh
INITEOF
  sudo chmod +x "$MNT/init"

  sudo umount "$MNT"
  sudo mv "/tmp/$OUTPUT" "$ROOTFS_DIR/$OUTPUT"
  rm -f /tmp/rootfs-export.tar

  echo "===> Done: $ROOTFS_DIR/$OUTPUT"
}

# ---------------------------------------------------------------------------
# Python rootfs — matches the Docker executor's blueberry-python:3.11 packages
# ---------------------------------------------------------------------------
build_image "blueberry-rootfs-python" \
"FROM python:3.11-slim
RUN pip install --no-cache-dir numpy pandas matplotlib
RUN mkdir -p /workspace /opt/agent" \
  1500 "rootfs-python.ext4"

# ---------------------------------------------------------------------------
# Node.js rootfs — matches node:20-slim
# ---------------------------------------------------------------------------
build_image "blueberry-rootfs-node" \
"FROM node:20-slim
RUN mkdir -p /workspace /opt/agent" \
  800 "rootfs-node.ext4"

echo ""
echo "==> All rootfs images built successfully!"
echo "    Python: $ROOTFS_DIR/rootfs-python.ext4"
echo "    Node:   $ROOTFS_DIR/rootfs-node.ext4"
echo "    Kernel: $ROOTFS_DIR/vmlinux.bin  (downloaded by instance-setup.sh)"
