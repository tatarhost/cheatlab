"""Kaggle notebook worker. Configure Kaggle Secrets before pushing:
MASTER_PUBLIC_URL, CLUSTER_SECRET, PINGGY_SSH_TARGET, MODEL_PATH, optional HF_TOKEN.
No secrets are embedded in this source file.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import signal
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

from kaggle_secrets import UserSecretsClient

secrets = UserSecretsClient()
def secret(name: str, default: str = "") -> str:
    try:
        return secrets.get_secret(name)
    except Exception:
        return os.getenv(name, default)

MASTER = secret("MASTER_PUBLIC_URL").rstrip("/")
CLUSTER_SECRET = secret("CLUSTER_SECRET")
PINGGY_TARGET = secret("PINGGY_SSH_TARGET", "a.pinggy.io")
MODEL_PATH = secret("MODEL_PATH", "/kaggle/input/ail-model/model.gguf")
NODE_ID = os.getenv("KAGGLE_KERNEL_SLUG", "kaggle-worker-" + str(int(time.time())))
PORT = int(os.getenv("LLAMA_PORT", "8080"))
if not MASTER.startswith("https://") or not CLUSTER_SECRET:
    raise RuntimeError("Missing MASTER_PUBLIC_URL or CLUSTER_SECRET in Kaggle Secrets")

def node_key() -> str:
    return hmac.new(CLUSTER_SECRET.encode(), ("worker:" + NODE_ID).encode(), hashlib.sha256).hexdigest()

def post(path: str, payload: dict, headers: dict | None = None) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(MASTER + path, data=data, headers={
        "Content-Type": "application/json", "X-Cluster-Secret": CLUSTER_SECRET,
        **(headers or {}),
    }, method="POST")
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.loads(response.read() or b"{}")

def ensure_llama_server() -> str:
    binary = os.getenv("LLAMA_SERVER_BIN", "/usr/local/bin/llama-server")
    if Path(binary).exists():
        return binary
    # Build llama.cpp with CUDA inside the Kaggle image. This is intentionally
    # explicit and reproducible; it does not overwrite system CUDA libraries.
    subprocess.run(["bash", "-lc",
        "apt-get update && apt-get install -y --no-install-recommends git cmake build-essential",
    ], check=True, timeout=900)
    subprocess.run(["bash", "-lc",
        "git clone --depth 1 https://github.com/ggml-org/llama.cpp /tmp/llama.cpp && "
        "cmake -S /tmp/llama.cpp -B /tmp/llama.cpp/build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release && "
        "cmake --build /tmp/llama.cpp/build --config Release -j2 --target llama-server",
    ], check=True, timeout=5400)
    return "/tmp/llama.cpp/build/bin/llama-server"

def wait_http(url: str, timeout: int = 900) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=4):
                return
        except Exception:
            time.sleep(3)
    raise TimeoutError("llama-server did not become ready")

def tunnel_url(process: subprocess.Popen, timeout: int = 90) -> str:
    # Pinggy prints the assigned HTTPS forwarding URL to SSH's combined output.
    import selectors
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Pinggy SSH process exited before publishing a URL")
        for key, _ in selector.select(timeout=1):
            line = key.fileobj.readline()
            match = re.search(r"https://[a-zA-Z0-9.-]+\.pinggy\.link", line)
            if match:
                return match.group(0)
    raise TimeoutError("Could not obtain Pinggy HTTPS URL")

def main() -> None:
    server = ensure_llama_server()
    if not Path(MODEL_PATH).is_file():
        raise FileNotFoundError("MODEL_PATH does not exist; attach a model dataset to this Kaggle notebook")
    api_key = node_key()
    llama = subprocess.Popen([
        server, "-m", MODEL_PATH, "--host", "127.0.0.1", "--port", str(PORT),
        "--api-key", api_key, "--metrics",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    wait_http(f"http://127.0.0.1:{PORT}/health")
    current_tunnel = None
    stop = threading.Event()

    def heartbeat() -> None:
        while not stop.is_set():
            try:
                post("/api/cluster/heartbeat", {
                    "node_id": NODE_ID, "status": "idle", "active_requests": 0,
                })
            except Exception:
                pass
            stop.wait(15)

    threading.Thread(target=heartbeat, daemon=True).start()
    try:
        while llama.poll() is None:
            if current_tunnel is None or current_tunnel.poll() is not None:
                if current_tunnel is not None:
                    current_tunnel.terminate()
                    try: current_tunnel.wait(timeout=8)
                    except subprocess.TimeoutExpired: current_tunnel.kill()
                current_tunnel = subprocess.Popen([
                    "ssh", "-p", "443", "-o", "StrictHostKeyChecking=no",
                    "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=yes",
                    "-R", f"0:127.0.0.1:{PORT}", PINGGY_TARGET,
                ], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
                public_url = tunnel_url(current_tunnel)
                post("/api/cluster/register", {
                    "node_id": NODE_ID, "worker_url": public_url + "/v1",
                })
            # Rotate the tunnel on a bounded schedule; the worker remains within
            # its Kaggle session lifetime and does not launch replacement sessions.
            time.sleep(5)
    finally:
        stop.set()
        if current_tunnel and current_tunnel.poll() is None:
            current_tunnel.terminate()
        if llama.poll() is None:
            llama.terminate()

if __name__ == "__main__":
    main()
