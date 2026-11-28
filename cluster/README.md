# CHEATLAB Kaggle AI Cluster

This is a separate FastAPI service. It does **not** replace the existing Cloudflare Worker. Deploy it on a persistent HTTPS host, then route a dedicated hostname (for example `api.cheatlab.fun`) to port 8000. Do not point the existing site API hostname at this service unless the Worker routes are deliberately migrated.

## Included

- OpenAI-compatible `POST /v1/chat/completions`, `POST /v1/completions`, `GET /v1/models`.
- Stable client bearer token, separate worker credentials derived from `CLUSTER_SECRET`.
- Least-connections selection with round-robin tie breaking and FIFO waiting queue.
- SSE/raw streaming pass-through.
- Worker registration and 15-second heartbeat; nodes missing for 45 seconds are removed.
- Admin-only status and scale-up endpoints.
- Kaggle kernel push via the official Kaggle CLI, private notebook metadata, GPU + internet flags.
- Kaggle concurrency hard-capped at two nodes. No session cycling or quota evasion.

## Important deployment facts

1. This first version keeps the node pool and FIFO queue in memory. Run exactly **one hub replica**. For multiple replicas, move node state, leases, and queue tickets to Redis before scaling the hub.
2. Kaggle GPU availability, accelerator identifiers, notebook runtime, and quotas are controlled by Kaggle and may change. The manager refuses to exceed the configured cap (maximum two), but you must verify that the selected accelerator is available to your account.
3. Kaggle notebook code cannot safely contain credentials. Add `MASTER_PUBLIC_URL`, `CLUSTER_SECRET`, `PINGGY_SSH_TARGET`, and `MODEL_PATH` as Kaggle Secrets in the Kaggle account before running worker notebooks. Attach a private Kaggle Dataset containing your model and set `MODEL_PATH` to its actual file.
4. The worker template builds llama.cpp with CUDA if no `LLAMA_SERVER_BIN` is supplied. This can take a long time and may fail if Kaggle's image/toolchain changes.
5. The Pinggy URL is ephemeral. The worker registers every new URL. Confirm Pinggy's current SSH target and usage terms; this integration does not promise a permanently stable tunnel.
6. Kaggle session lifetime is controlled by Kaggle. This project does not kill/relaunch sessions to bypass runtime or GPU quotas.

## Configure

Copy `.env.example` to `.env` on the deployment host. Fill in values there; never commit `.env`. The repository root `.gitignore` already ignores `.env*`.

Generate independent secrets locally, for example:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Set `OPENAI_API_KEY`, `CLUSTER_SECRET`, `ADMIN_PASSWORD`, `KAGGLE_USERNAME`, and `KAGGLE_KEY` in the host's secret manager. Do not paste credentials into source code, issues, or chat. Since an admin password was shared in a chat, replace it with a new unique value before production.

## Run

```bash
cd cluster
cp .env.example .env
# Edit .env on the server
docker build -f Dockerfile -t cheatlab-cluster ..
docker run --env-file .env -v cheatlab-kaggle-state:/data -p 8000:8000 cheatlab-cluster
```

For a direct Python run:

```bash
pip install -r requirements.txt
uvicorn hub_proxy:app --host 0.0.0.0 --port 8000
```

Terminate TLS at a trusted reverse proxy. Restrict admin endpoints at the network layer as well as by password. Do not expose port 8000 directly to the public internet without HTTPS.

## Internal endpoints

- `POST /api/cluster/register` — `X-Cluster-Secret` header; JSON `{ "node_id": "...", "worker_url": "https://....pinggy.link/v1" }`.
- `POST /api/cluster/heartbeat` — `X-Cluster-Secret` header; JSON `{ "node_id": "...", "status": "idle|busy|draining", "active_requests": 0 }`.
- `POST /api/cluster/scale-up` — `X-Admin-Password` header.
- `GET /api/cluster/status` — `X-Admin-Password` header.

## OpenAI client

Base URL: `https://api.cheatlab.fun/v1`

API key: the value configured as `OPENAI_API_KEY`.

Set `AUTO_SCALE_ENABLED=true` only after Kaggle credentials, Kaggle Secrets, model dataset, and Pinggy connectivity have been tested. The hub then requests one extra Kaggle kernel when a node is already serving traffic, subject to the live-kernel quota check and a five-minute cooldown. Scale-up is best-effort; requests remain queued while a node starts.\n\nThe hub retries a request only when it fails before an upstream response is established (or when an upstream returns 502/503/504 before streaming starts). It cannot safely replay a generation after bytes have been sent to the client.

## GitHub Actions

Store credentials as repository/environment secrets if you later add a deployment workflow. The current repository does not automatically deploy this Python service: GitHub Pages and the existing Cloudflare Worker cannot host a persistent FastAPI process.
