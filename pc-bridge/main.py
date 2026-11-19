import json
import os
import platform
import queue
import socket
import threading
import time
import tkinter as tk
import urllib.error
import urllib.request
from pathlib import Path
from tkinter import messagebox, ttk

API = "https://cheatlab.tatarhost.workers.dev"
APP_TITLE = "CHEATLAB PC Bridge"
ALLOWED_EXTENSIONS = {".txt", ".md", ".json", ".csv"}
MAX_FILE_BYTES = 64 * 1024


def request_json(path, secret, payload=None, timeout=12):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Accept": "application/json", "X-CheatLab-MCP-Secret": secret}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=data, headers=headers, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read(96 * 1024 + 1)
            if len(raw) > 96 * 1024:
                raise RuntimeError("Ответ сервера слишком большой.")
            return json.loads(raw.decode("utf-8")) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read(4096).decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except Exception:
            pass
        raise RuntimeError(str(detail) or "Ошибка сервера HTTP " + str(exc.code)) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError("Нет соединения с CHEATLAB: " + str(exc.reason)) from exc


def shared_root():
    folder = Path.home() / "CheatLab-Shared"
    if folder.is_symlink():
        raise RuntimeError("Папка CheatLab-Shared не должна быть символической ссылкой.")
    folder.mkdir(parents=True, exist_ok=True)
    return folder.resolve()


def run_pc_tool(name, args):
    if name == "pc_get_system_info":
        return {
            "computer_name": socket.gethostname(),
            "platform": platform.platform(),
            "system": platform.system(),
            "architecture": platform.machine(),
            "python_version": platform.python_version(),
            "logical_cpu_count": os.cpu_count() or 1,
        }

    root = shared_root()
    if name == "pc_list_shared_files":
        files = []
        for item in sorted(root.iterdir(), key=lambda p: p.name.lower()):
            try:
                if item.name.startswith(".") or item.is_symlink() or not item.is_file() or item.suffix.lower() not in ALLOWED_EXTENSIONS:
                    continue
                size = item.stat().st_size
                if size <= MAX_FILE_BYTES and len(files) < 100:
                    files.append({"name": item.name, "size": size, "extension": item.suffix.lower()})
            except OSError:
                continue
        return {"folder": "CheatLab-Shared", "files": files, "max_file_bytes": MAX_FILE_BYTES}

    if name == "pc_read_shared_file":
        filename = args.get("name")
        if not isinstance(filename, str) or not filename or filename in {".", ".."}:
            raise RuntimeError("Укажите имя файла из списка.")
        if Path(filename).name != filename or "/" in filename or "\\" in filename:
            raise RuntimeError("Разрешено читать только файлы верхнего уровня общей папки.")
        candidate = root / filename
        if candidate.is_symlink() or candidate.suffix.lower() not in ALLOWED_EXTENSIONS:
            raise RuntimeError("Тип файла не разрешён.")
        resolved = candidate.resolve(strict=True)
        if resolved.parent != root or not resolved.is_file():
            raise RuntimeError("Файл находится вне общей папки.")
        if resolved.stat().st_size > MAX_FILE_BYTES:
            raise RuntimeError("Файл превышает лимит 64 КБ.")
        content = resolved.read_text(encoding="utf-8")
        return {"name": filename, "content": content}
    raise RuntimeError("Неизвестный инструмент. Команды компьютера не поддерживаются.")


class BridgeApp:
    def __init__(self, root):
        self.root = root
        self.root.title(APP_TITLE)
        self.root.geometry("560x440")
        self.root.minsize(520, 400)
        self.root.configure(bg="#101114")
        self.events = queue.Queue()
        self.stop_event = threading.Event()
        self.thread = None
        self.connection_id = None
        self.secret_var = tk.StringVar()
        self.status_var = tk.StringVar(value="Не подключено")
        self._build()
        self.root.after(150, self._drain_events)
        self.root.protocol("WM_DELETE_WINDOW", self.close)

    def _build(self):
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("TFrame", background="#101114")
        style.configure("TLabel", background="#101114", foreground="#f1f2f4", font=("Segoe UI", 10))
        style.configure("Title.TLabel", font=("Segoe UI Semibold", 19))
        style.configure("Muted.TLabel", foreground="#9ca1aa")
        style.configure("TButton", padding=9, font=("Segoe UI", 9))
        outer = ttk.Frame(self.root, padding=22)
        outer.pack(fill="both", expand=True)
        ttk.Label(outer, text="CHEATLAB / DEVICE BRIDGE", style="Muted.TLabel").pack(anchor="w")
        ttk.Label(outer, text="Подключение компьютера", style="Title.TLabel").pack(anchor="w", pady=(5, 4))
        ttk.Label(
            outer,
            text="Вставьте одноразовый код со страницы cheatlab.fun/mcp. Запрос появится в вашем аккаунте для подтверждения.",
            wraplength=500, style="Muted.TLabel"
        ).pack(anchor="w", pady=(0, 14))
        self.code_entry = ttk.Entry(outer, textvariable=self.secret_var, font=("Consolas", 10))
        self.code_entry.pack(fill="x", ipady=7)
        self.start_button = ttk.Button(outer, text="Подключить этот ПК", command=self.start)
        self.start_button.pack(fill="x", pady=(10, 8))
        row = ttk.Frame(outer)
        row.pack(fill="x")
        ttk.Label(row, text="Состояние:", style="Muted.TLabel").pack(side="left")
        ttk.Label(row, textvariable=self.status_var).pack(side="left", padx=8)
        self.stop_button = ttk.Button(row, text="Отключить", command=self.stop, state="disabled")
        self.stop_button.pack(side="right")
        ttk.Separator(outer).pack(fill="x", pady=14)
        ttk.Label(outer, text="CHEATLAB-Shared", font=("Segoe UI Semibold", 11)).pack(anchor="w")
        ttk.Label(
            outer,
            text="ИИ сможет видеть только файлы .txt, .md, .json и .csv, которые вы сами положите в эту папку. Максимум 64 КБ на файл. Папка создаётся автоматически.",
            wraplength=500, style="Muted.TLabel"
        ).pack(anchor="w", pady=(5, 10))
        path = str(Path.home() / "CheatLab-Shared")
        path_label = ttk.Label(outer, text=path, wraplength=500)
        path_label.pack(anchor="w")
        self.log = tk.Text(
            outer, height=7, bg="#181a1f", fg="#d9dce2", insertbackground="white",
            relief="flat", font=("Consolas", 9), wrap="word", state="disabled"
        )
        self.log.pack(fill="both", expand=True, pady=(12, 0))
        self._log("Приложение готово. Команды Windows и произвольный доступ к диску не предоставляются.")

    def _log(self, message):
        self.log.configure(state="normal")
        self.log.insert("end", time.strftime("[%H:%M:%S] ") + message + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _event(self, kind, value):
        self.events.put((kind, value))

    def _drain_events(self):
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "status":
                    self.status_var.set(value)
                elif kind == "log":
                    self._log(value)
                elif kind == "approved":
                    self.start_button.configure(state="disabled")
                    self.stop_button.configure(state="normal")
                    self.code_entry.configure(state="disabled")
                elif kind == "stopped":
                    self.start_button.configure(state="normal")
                    self.stop_button.configure(state="disabled")
                    self.code_entry.configure(state="normal")
                elif kind == "error":
                    self._log("Ошибка: " + value)
                    self.status_var.set("Ошибка подключения")
        except queue.Empty:
            pass
        self.root.after(150, self._drain_events)

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        secret = self.secret_var.get().strip()
        if not secret.startswith("mcp_") or len(secret) != 36:
            messagebox.showerror("Неверный код", "Вставьте полный код mcp_… со страницы CHEATLAB.")
            return
        self.stop_event.clear()
        self.start_button.configure(state="disabled")
        self.status_var.set("Создание запроса…")
        self.thread = threading.Thread(target=self._worker, args=(secret,), daemon=True)
        self.thread.start()

    def _worker(self, secret):
        connection_id = None
        try:
            connected = request_json("/api/mcp/agent/connect", secret, {
                "deviceName": socket.gethostname()[:64],
                "platform": platform.platform()[:40],
                "pythonVersion": platform.python_version()[:32],
            })
            connection_id = connected["connectionId"]
            self.connection_id = connection_id
            self._event("log", "Запрос отправлен. Подтвердите подключение на сайте CHEATLAB.")
            self._event("status", "Ожидает подтверждения")
            last_status = 0.0
            last_pending_heartbeat = 0.0
            approved = False
            while not self.stop_event.is_set():
                if not approved and time.monotonic() - last_status >= 2.5:
                    state = request_json("/api/mcp/agent/status/" + connection_id, secret)
                    last_status = time.monotonic()
                    if state.get("status") == "approved":
                        approved = True
                        self._event("approved", None)
                        self._event("status", "Подключено")
                        self._event("log", "Владелец подтвердил подключение. Доступны только безопасные инструменты чтения.")
                    elif state.get("status") in {"denied", "revoked", "expired", "disconnected"}:
                        raise RuntimeError("Подключение отклонено, отозвано или истекло.")
                if approved:
                    packet = request_json("/api/mcp/agent/next/" + connection_id, secret, {})
                    if packet.get("status") != "approved":
                        raise RuntimeError("Подключение было отключено или отозвано владельцем на сайте.")
                    job = packet.get("job")
                    if job:
                        try:
                            result = run_pc_tool(job.get("tool", ""), job.get("arguments") or {})
                            payload = {"result": result}
                        except Exception as exc:
                            payload = {"result": {"error": str(exc)[:1000]}}
                        request_json("/api/mcp/agent/result/" + connection_id + "/" + job["id"], secret, payload)
                    else:
                        time.sleep(0.65)
                else:
                    time.sleep(1.5)
        except Exception as exc:
            self._event("error", str(exc)[:1000])
        finally:
            if connection_id:
                try:
                    request_json("/api/mcp/agent/disconnect/" + connection_id, secret, {})
                except Exception:
                    pass
            self.connection_id = None
            self._event("status", "Отключено")
            self._event("stopped", None)

    def stop(self):
        self.stop_event.set()
        self.status_var.set("Отключение…")

    def close(self):
        self.stop_event.set()
        self.root.after(200, self.root.destroy)


def main():
    root = tk.Tk()
    BridgeApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
