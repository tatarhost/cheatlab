from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import AsyncIterator

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    openai_api_key: str = ""
    cluster_secret: str = ""
    admin_password: str = ""
    master_public_url: str = "https://cheatlab.fun"
    model_id: str = "ail-latest"
    node_heartbeat_timeout: int = 45
    queue_timeout_seconds: int = 180
    max_request_bytes: int = 10 * 1024 * 1024
    worker_url_suffix: str = ".pinggy.link"
    auto_scale_enabled: bool = False
    max_gpu_nodes: int = 2


settings = Settings()


def _constant_equal(given: str | None, expected: str) -> bool:
    return bool(given) and hmac.compare_digest(given.encode(), expected.encode())


def _node_api_key(node_id: str) -> str:
    return hmac.new(settings.cluster_secret.encode(), ("worker:" + node_id).encode(), hashlib.sha256).hexdigest()


@dataclass
class Node:
    node_id: str
    worker_url: str
    status: str = "idle"
    active_requests: int = 0
    last_seen: float = field(default_factory=time.monotonic)
    created_at: float = field(default_factory=time.monotonic)
    generation: int = 0


class NodePool:
    """Single-master in-memory pool. Run one replica, or replace with Redis for HA."""
    def __init__(self) -> None:
        self.nodes: dict[str, Node] = {}
        self.condition = asyncio.Condition()
        self.waiters: deque[str] = deque()
        self.round_robin = 0
        self.total_queued = 0

    def _live(self) -> list[Node]:
        now = time.monotonic()
        dead = [key for key, node in self.nodes.items()
                if now - node.last_seen > settings.node_heartbeat_timeout]
        for key in dead:
            self.nodes.pop(key, None)
        return list(self.nodes.values())

    def _choose(self) -> Node | None:
        live = [n for n in self._live() if n.status != "draining"]
        if not live:
            return None
        least = min(n.active_requests for n in live)
        candidates = sorted((n for n in live if n.active_requests == least), key=lambda n: n.node_id)
        chosen = candidates[self.round_robin % len(candidates)]
        self.round_robin += 1
        return chosen

    async def register(self, node_id: str, worker_url: str) -> None:
        async with self.condition:
            old = self.nodes.get(node_id)
            generation = old.generation + 1 if old else 1
            self.nodes[node_id] = Node(node_id=node_id, worker_url=worker_url, generation=generation)
            self.condition.notify_all()

    async def heartbeat(self, node_id: str, status: str, active_requests: int | None) -> None:
        async with self.condition:
            node = self.nodes.get(node_id)
            if node is None:
                raise KeyError(node_id)
            node.last_seen = time.monotonic()
            node.status = status if status in {"idle", "busy", "draining"} else "busy"
            # Do not let periodic heartbeats erase in-flight counts tracked by the hub.
            if active_requests is not None:
                node.active_requests = max(0, min(active_requests, 128))
            self.condition.notify_all()

    async def acquire(self) -> Node:
        ticket = uuid.uuid4().hex
        deadline = time.monotonic() + settings.queue_timeout_seconds
        async with self.condition:
            self.waiters.append(ticket)
            self.total_queued += 1
            try:
                while True:
                    if self.waiters and self.waiters[0] == ticket:
                        node = self._choose()
                        if node is not None:
                            self.waiters.popleft()
                            node.active_requests += 1
                            node.status = "busy"
                            self.condition.notify_all()
                            if settings.auto_scale_enabled and node.active_requests >= 1:
                                asyncio.create_task(_maybe_auto_scale())
                            return node
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("Очередь кластера переполнена или все ноды недоступны")
                    await asyncio.wait_for(self.condition.wait(), timeout=remaining)
            except BaseException:
                try:
                    self.waiters.remove(ticket)
                except ValueError:
                    pass
                self.condition.notify_all()
                raise

    async def release(self, node_id: str) -> None:
        async with self.condition:
            node = self.nodes.get(node_id)
            if node:
                node.active_requests = max(0, node.active_requests - 1)
                if node.active_requests == 0 and node.status == "busy":
                    node.status = "idle"
                node.last_seen = time.monotonic()
            self.condition.notify_all()

    async def snapshot(self) -> dict:
        async with self.condition:
            nodes = self._live()
            return {
                "nodes": [{"node_id": n.node_id, "status": n.status,
                           "active_requests": n.active_requests,
                           "age_seconds": int(time.monotonic() - n.created_at)}
                          for n in nodes],
                "queue_depth": len(self.waiters),
                "total_queued": self.total_queued,
                "max_gpu_nodes": settings.max_gpu_nodes,
            }


pool = NodePool()
client: httpx.AsyncClient | None = None
_auto_scale_lock = asyncio.Lock()
_last_auto_scale = 0.0


async def _maybe_auto_scale() -> None:
    global _last_auto_scale
    if not settings.auto_scale_enabled:
        return
    async with _auto_scale_lock:
        now = time.monotonic()
        if now - _last_auto_scale < 300:
            return
        snapshot = await pool.snapshot()
        nodes = snapshot["nodes"]
        if len(nodes) >= settings.max_gpu_nodes or not nodes:
            return
        if not any(n["active_requests"] > 0 for n in nodes) and snapshot["queue_depth"] <= 1:
            return
        _last_auto_scale = now
        try:
            from kaggle_manager import KaggleManager
            await KaggleManager().scale_up()
        except Exception:
            # Scaling is best-effort; requests remain in the FIFO queue.
            return


@asynccontextmanager
async def lifespan(_: FastAPI):
    global client
    if not settings.openai_api_key or not settings.cluster_secret or not settings.admin_password:
        raise RuntimeError("Set OPENAI_API_KEY, CLUSTER_SECRET and ADMIN_PASSWORD before startup")
    client = httpx.AsyncClient(timeout=httpx.Timeout(connect=12, read=None, write=60, pool=20),
                               limits=httpx.Limits(max_connections=200, max_keepalive_connections=40))
    sweeper = asyncio.create_task(_sweep())
    try:
        yield
    finally:
        sweeper.cancel()
        await client.aclose()


app = FastAPI(title="CHEATLAB AI Cluster Hub", version="1.0.0", lifespan=lifespan)


async def _sweep() -> None:
    while True:
        async with pool.condition:
            pool._live()
            pool.condition.notify_all()
        await asyncio.sleep(5)


def _require_cluster(secret: str | None) -> None:
    if not _constant_equal(secret, settings.cluster_secret):
        raise HTTPException(401, "Invalid cluster credentials")


def _require_admin(password: str | None) -> None:
    if not _constant_equal(password, settings.admin_password):
        raise HTTPException(401, "Invalid admin credentials")


def _validate_worker_url(value: str) -> str:
    from urllib.parse import urlsplit
    parsed = urlsplit(value)
    suffix = settings.worker_url_suffix.lower()
    host = (parsed.hostname or "").lower()
    if (parsed.scheme != "https" or not host.endswith(suffix) or
            parsed.port not in (None, 443) or parsed.username or parsed.password or
            parsed.query or parsed.fragment or not parsed.path.rstrip("/").endswith("/v1")):
        raise HTTPException(400, "worker_url must be an HTTPS Pinggy /v1 URL")
    return value.rstrip("/")


@app.get("/health")
async def health():
    return {"ok": True, "service": "cheatlab-cluster-hub"}


@app.post("/api/cluster/register")
async def register_node(payload: dict, x_cluster_secret: str | None = Header(default=None)):
    _require_cluster(x_cluster_secret or payload.get("secret"))
    node_id = str(payload.get("node_id", ""))[:80]
    if not node_id or not all(c.isalnum() or c in "-_" for c in node_id):
        raise HTTPException(400, "Invalid node_id")
    url = _validate_worker_url(str(payload.get("worker_url", "")))
    await pool.register(node_id, url)
    return {"ok": True, "node_id": node_id}


@app.post("/api/cluster/heartbeat")
async def heartbeat(payload: dict, x_cluster_secret: str | None = Header(default=None)):
    _require_cluster(x_cluster_secret or payload.get("secret"))
    node_id = str(payload.get("node_id", ""))
    try:
        await pool.heartbeat(node_id, str(payload.get("status", "busy")),
                             int(payload["active_requests"]) if "active_requests" in payload else None)
    except KeyError:
        raise HTTPException(404, "Node is not registered; register again")
    return {"ok": True}


@app.post("/api/cluster/scale-up")
async def scale_up(x_admin_password: str | None = Header(default=None)):
    _require_admin(x_admin_password)
    from kaggle_manager import KaggleManager
    manager = KaggleManager()
    result = await manager.scale_up()
    return result


@app.get("/api/cluster/status")
async def cluster_status(x_admin_password: str | None = Header(default=None)):
    _require_admin(x_admin_password)
    return await pool.snapshot()


def _require_openai_key(authorization: str | None) -> None:
    expected = "Bearer " + settings.openai_api_key
    if not _constant_equal(authorization, expected):
        raise HTTPException(401, "Invalid API key")


async def _stream_worker(node: Node, path: str, query: str, body: bytes,
                         headers: dict[str, str]) -> httpx.Response:
    assert client is not None
    target = node.worker_url + ("/" + path if path else "")
    if query:
        target += "?" + query
    forwarded = {k: v for k, v in headers.items()
                 if k.lower() in {"content-type", "accept", "x-request-id"}}
    forwarded["Authorization"] = "Bearer " + _node_api_key(node.node_id)
    return await client.send(client.build_request("POST", target, content=body, headers=forwarded),
                             stream=True)


@app.api_route("/v1/{path:path}", methods=["GET", "POST"])
async def openai_proxy(path: str, request: Request,
                       authorization: str | None = Header(default=None)):
    _require_openai_key(authorization)
    if path not in {"chat/completions", "completions", "models"}:
        raise HTTPException(404, "Unsupported OpenAI endpoint")
    if request.method == "GET" and path != "models":
        raise HTTPException(405, "Method not allowed")
    body = await request.body()
    if len(body) > settings.max_request_bytes:
        raise HTTPException(413, "Request body too large")

    # A connection failure before the upstream response is received can be retried.
    # Once any response body is sent, transparent retry is deliberately disabled.
    attempts = 2
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            node = await pool.acquire()
        except TimeoutError as exc:
            raise HTTPException(503, str(exc))
        upstream: httpx.Response | None = None
        try:
            if path == "models":
                method = "GET"
                assert client is not None
                upstream = await client.send(client.build_request(
                    method, node.worker_url + "/models",
                    headers={"Authorization": "Bearer " + _node_api_key(node.node_id),
                             "Accept": "application/json"}), stream=True)
            else:
                upstream = await _stream_worker(node, path, request.url.query, body,
                                                dict(request.headers))
            if upstream.status_code in {502, 503, 504} and attempt + 1 < attempts:
                await upstream.aclose()
                await pool.release(node.node_id)
                continue
            response_headers = {k: v for k, v in upstream.headers.items()
                                if k.lower() in {"content-type", "cache-control", "x-request-id"}}
            async def iterator(response: httpx.Response, leased_node: str) -> AsyncIterator[bytes]:
                try:
                    async for chunk in response.aiter_raw():
                        yield chunk
                finally:
                    await response.aclose()
                    await pool.release(leased_node)
            return StreamingResponse(iterator(upstream, node.node_id),
                                     status_code=upstream.status_code, headers=response_headers)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as exc:
            last_error = exc
            if upstream is not None:
                await upstream.aclose()
            await pool.release(node.node_id)
            if attempt + 1 >= attempts:
                break
        except Exception:
            if upstream is not None:
                await upstream.aclose()
            await pool.release(node.node_id)
            raise
    raise HTTPException(502, f"No worker accepted the request: {type(last_error).__name__ if last_error else 'unavailable'}")
