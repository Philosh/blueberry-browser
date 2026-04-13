# Blueberry exec server (Firecracker)

Fastify API: `POST /execute`, `GET /health`. Each request runs user code in a dedicated Firecracker microVM (rootfs clone per run).

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `BLUEBERRY_API_KEY` | — | If set, `Authorization: Bearer …` must match |
| `MAX_CONCURRENT_VMS` | `15` | Reject excess work with **503** when this many VMs are running |
| `VM_HOST_OVERHEAD_MS` | `25000` | Extra host time beyond payload `timeoutMs` before kill |
| `RATE_LIMIT_MAX` | `30` | Max `/execute` requests per client IP per window (`0` = disable plugin) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in ms |
| `TRUST_PROXY` | off | Set to `1` or `true` behind GCP HTTP(S) LB so `request.ip` uses `X-Forwarded-For` (per-client limits work) |

`GET /health` is excluded from rate limiting so load balancer probes do not consume the budget.

## Tuning `MAX_CONCURRENT_VMS`

This caps simultaneous Firecracker VMs on **one** machine. Set it from RAM and vCPU: each VM uses memory for the guest plus host overhead; oversubscribing causes thrashing or OOM.

- Start conservative (e.g. **4–8** on a 4 vCPU / 16 GiB node), then increase while watching `activeVMs` in `/health`, CPU, and memory under load.
- If you routinely hit **503**, either raise capacity on that instance or add more executor VMs behind a load balancer (preferred).

## Horizontal scaling on GCP (simple path)

No extra databases or queues required: **N identical executor instances** and one **HTTP(S) load balancer** in front.

1. **Golden image** — Build a machine image (or instance template) that includes your rootfs, Firecracker, and this server; use `scripts/gcp-setup.sh`, `instance-setup.sh`, `build-rootfs.sh` as the basis.
2. **Backend service** — Instance group (unmanaged or **MIG**), backend port **3000** (or your `PORT`), health check **HTTP GET** `/health`.
3. **Load balancer** — External HTTP(S) LB → backend service → instance group.
4. **Clients** — `CODE_EXEC_API_URL=https://<lb-hostname>/execute` (full URL including `/execute`).
5. **Env on each node** — Same `BLUEBERRY_API_KEY`, `MAX_CONCURRENT_VMS`, and tuned `RATE_LIMIT_MAX`; enable `TRUST_PROXY` when the LB forwards client IPs.

Optional: MIG **autoscaler** on average CPU.

## Electron client (remote executor)

| Variable | Default | Purpose |
|----------|---------|---------|
| `CODE_EXEC_MAX_ATTEMPTS` | `3` | Total HTTP attempts for **503** / **429** (exponential backoff between tries) |
| `CODE_EXEC_RETRY_BASE_MS` | `500` | Base delay before first retry (doubles each attempt, plus small jitter) |
