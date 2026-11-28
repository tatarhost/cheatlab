from __future__ import annotations

import asyncio
import json
import os
import subprocess
import re
import tempfile
import time
import sqlite3
import threading
from pathlib import Path

from kaggle.api.kaggle_api_extended import KaggleApi


class KaggleManager:
    """Uses the official Kaggle API/CLI and never launches beyond the configured quota."""
    def __init__(self) -> None:
        self.username = os.getenv("KAGGLE_USERNAME", "").strip()
        self.key = os.getenv("KAGGLE_KEY", "").strip()
        self.max_nodes = min(2, max(1, int(os.getenv("KAGGLE_MAX_GPU_NODES", "2"))))
        self.accelerator = os.getenv("KAGGLE_ACCELERATOR", "NvidiaTeslaT4")
        self.master_url = os.getenv("MASTER_PUBLIC_URL", "").rstrip("/")
        self.cluster_secret = os.getenv("CLUSTER_SECRET", "")
        self.model_path = os.getenv("MODEL_PATH", "/kaggle/input/ail-model/model.gguf")
        self.state_db = Path(os.getenv("CLUSTER_STATE_DB", "/data/kaggle_state.sqlite3"))
        self.state_db.parent.mkdir(parents=True, exist_ok=True)
        self.worker_template = Path(__file__).with_name("worker_template.py")
        if not self.username or not self.key:
            raise RuntimeError("KAGGLE_USERNAME and KAGGLE_KEY are required")
        if not self.master_url.startswith("https://") or not self.cluster_secret:
            raise RuntimeError("MASTER_PUBLIC_URL and CLUSTER_SECRET are required")

    def _api(self) -> KaggleApi:
        os.environ["KAGGLE_USERNAME"] = self.username
        os.environ["KAGGLE_KEY"] = self.key
        api = KaggleApi()
        api.authenticate()
        return api

    async def scale_up(self) -> dict:
        # Persist launch reservations across hub restarts. A Kaggle GPU session is
        # treated as occupying a slot for up to 12h; no session cycling is attempted.
        async with _launch_lock:
            return await asyncio.to_thread(self._reserve_and_push)

    def _reserve_and_push(self) -> dict:
        now = int(time.time())
        with sqlite3.connect(self.state_db, timeout=20) as db:
            db.execute("CREATE TABLE IF NOT EXISTS launches (kernel TEXT PRIMARY KEY, node_id TEXT NOT NULL, launched_at INTEGER NOT NULL)")
            db.execute("DELETE FROM launches WHERE launched_at < ?", (now - 12 * 60 * 60,))
            rows = db.execute("SELECT kernel FROM launches").fetchall()
            active = 0
            stale: list[str] = []
            for (kernel,) in rows:
                status = subprocess.run(
                    ["kaggle", "kernels", "status", kernel],
                    capture_output=True, text=True, timeout=45,
                    env={**os.environ, "KAGGLE_USERNAME": self.username, "KAGGLE_KEY": self.key},
                    check=False,
                )
                state = (status.stdout + " " + status.stderr).upper()
                if status.returncode == 0 and any(word in state for word in ("RUNNING", "QUEUED", "STARTING", "INITIALIZING")):
                    active += 1
                elif status.returncode == 0 and any(word in state for word in ("COMPLETE", "ERROR", "CANCELLED", "CANCELED")):
                    stale.append(kernel)
                else:
                    # Unknown status is counted as active: fail closed rather than
                    # risk exceeding Kaggle's concurrent GPU quota.
                    active += 1
            if stale:
                db.executemany("DELETE FROM launches WHERE kernel=?", [(k,) for k in stale])
            if active >= self.max_nodes:
                return {"ok": False, "reason": "Kaggle GPU quota is already in use", "active": active, "limit": self.max_nodes}
            return self._push_kernel(db)

    def _push_kernel(self, db: sqlite3.Connection) -> dict:
        self._api()
        slug_base = re.sub(r"[^a-z0-9-]", "-", os.getenv("KAGGLE_KERNEL_PREFIX", "cheatlab-ai-worker").lower()).strip("-")
        kernel_slug = f"{slug_base}-node-{int(time.time())}-{os.urandom(2).hex()}".lower()
        node_id = kernel_slug
        with tempfile.TemporaryDirectory(prefix="cheatlab-kaggle-") as tmp:
            folder = Path(tmp)
            worker_source = self.worker_template.read_text(encoding="utf-8").replace("__CHEATLAB_NODE_ID__", node_id)
            (folder / "worker_template.py").write_text(worker_source, encoding="utf-8")
            metadata = {
                "id": f"{self.username}/{kernel_slug}",
                "title": f"CHEATLAB AI Worker {node_id}",
                "code_file": "worker_template.py",
                "language": "python",
                "kernel_type": "notebook",
                "is_private": True,
                "enable_gpu": True,
                "enable_internet": True,
                "accelerator": self.accelerator,
                "dataset_sources": [],
                "competition_sources": [],
                "kernel_sources": [],
                "model_sources": [],
            }
            (folder / "kernel-metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
            result = subprocess.run(
                ["kaggle", "kernels", "push", "-p", str(folder)],
                capture_output=True, text=True, timeout=180,
                env={**os.environ, "KAGGLE_USERNAME": self.username, "KAGGLE_KEY": self.key},
                check=False,
            )
            if result.returncode:
                raise RuntimeError("Kaggle push failed: " + (result.stderr or result.stdout)[-1200:])
        db.execute("INSERT OR REPLACE INTO launches(kernel,node_id,launched_at) VALUES(?,?,?)",
                   (f"{self.username}/{kernel_slug}", node_id, int(time.time())))
        db.commit()
        return {"ok": True, "node_id": node_id, "kernel": f"{self.username}/{kernel_slug}",
                "status": "submitted", "note": "Kaggle execution starts asynchronously; node appears after registration."}



_launch_lock = asyncio.Lock()
