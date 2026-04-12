#!/bin/bash
# Blueberry Browser — Create the GCP Firecracker instance.
# Run from your LOCAL machine with gcloud CLI installed and authenticated.
#
# Prerequisites:
#   gcloud auth login
#   gcloud config set project blueberry-firecracker
set -euo pipefail

INSTANCE_NAME="${INSTANCE_NAME:-firecracker-dev}"
ZONE="${ZONE:-us-central1-b}"
MACHINE_TYPE="${MACHINE_TYPE:-n1-standard-2}"

echo "==> Creating GCP instance: $INSTANCE_NAME"

gcloud compute instances create "$INSTANCE_NAME" \
  --zone="$ZONE" \
  --machine-type="$MACHINE_TYPE" \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --enable-nested-virtualization \
  --boot-disk-size=40GB \
  --tags=https-server

echo "==> Creating firewall rule for API traffic"
gcloud compute firewall-rules create allow-blueberry-https \
  --allow tcp:443,tcp:3000 \
  --target-tags=https-server \
  --description="Allow HTTPS and API traffic for Blueberry exec service" \
  2>/dev/null || echo "Firewall rule already exists"

echo ""
echo "==> Instance created. SSH in with:"
echo "    gcloud compute ssh $INSTANCE_NAME --zone=$ZONE"
echo ""
echo "==> Then run instance-setup.sh on the instance:"
echo "    bash server/scripts/instance-setup.sh"
