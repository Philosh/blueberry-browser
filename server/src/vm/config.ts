import { join } from "path";
import type { CodeLanguage } from "../types";

const FIRECRACKER_DIR = process.env.FIRECRACKER_DIR ?? "/opt/firecracker";

export interface FirecrackerConfig {
  "boot-source": {
    kernel_image_path: string;
    boot_args: string;
  };
  drives: Array<{
    drive_id: string;
    path_on_host: string;
    is_root_device: boolean;
    is_read_only: boolean;
  }>;
  "machine-config": {
    vcpu_count: number;
    mem_size_mib: number;
  };
}

export function getKernelPath(): string {
  return join(FIRECRACKER_DIR, "vmlinux.bin");
}

export function getRootfsPath(language: CodeLanguage): string {
  const image =
    language === "python" ? "rootfs-python.ext4" : "rootfs-node.ext4";
  return join(FIRECRACKER_DIR, image);
}

export function buildFirecrackerConfig(
  rootfsPath: string,
  opts?: { vcpuCount?: number; memSizeMib?: number }
): FirecrackerConfig {
  return {
    "boot-source": {
      kernel_image_path: getKernelPath(),
      boot_args:
        "init=/init console=ttyS0 reboot=k panic=1 pci=off quiet",
    },
    drives: [
      {
        drive_id: "rootfs",
        path_on_host: rootfsPath,
        is_root_device: true,
        is_read_only: false,
      },
    ],
    "machine-config": {
      vcpu_count: opts?.vcpuCount ?? 1,
      mem_size_mib: opts?.memSizeMib ?? 256,
    },
  };
}
