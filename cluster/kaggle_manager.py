from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
import time
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
        # Kaggle's free GPU concurrency limit is treated as a hard cap, not something
        # to work around by cycling notebooks. Reservations are process-local; for
        # multi-replica deployments, put this service behind one orchestrator replica.
        global _launch_reservations
        if _launch_reservations >= self.max_nodes:
            return {"ok": False, "reason": "GPU quota is already reserved", "limit": self.max_nodes}
        _launch_reservations += 1
        try:
            return await asyncio.to_thread(self._push_kernel)
        finally:
            _launch_reservations = max(0, _launch_reservations - 1)

    def _push_kernel(self) -> dict:
        self._api()
        slug_base = re.sub(r"[^a-z0-9-]", "-", os.getenv("KAGGLE_KERNEL_PREFIX", "cheatlab-ai-worker").lower()).strip("-")
        node_id = f"node-{int(time.time())}-{os.urandom(2).hex()}"
        kernel_slug = f"{slug_base}-{node_id}".lower()
        with tempfile.TemporaryDirectory(prefix="cheatlab-kaggle-") as tmp:
            folder = Path(tmp)
            (folder / "worker_template.py").write_text(self.worker_template.read_text(encoding="utf-8"), encoding="utf-8")
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
            import subprocess
            result = subprocess.run(
                ["kaggle", "kernels", "push", "-p", str(folder)],
                capture_output=True, text=True, timeout=180,
                env={**os.environ, "KAGGLE_USERNAME": self.username, "KAGGLE_KEY": self.key},
                check=False,
            )
            if result.returncode:
                raise RuntimeError("Kaggle push failed: " + (result.stderr or result.stdout)[-1200:])
        return {"ok": True, "node_id": node_id, "kernel": f"{self.username}/{kernel_slug}",
                "status": "submitted", "note": "Kaggle execution starts asynchronously; node appears after registration."}


_launch_reservations = 0
