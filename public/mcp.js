function mcpPythonScript(ownerNick, serverId, serverSecret) {
  const lines = [
    "#!/usr/bin/env python3",
    "# CHEATLAB MCP — local, consent-based PC bridge.",
    "# Owner: " + ownerNick,
    "# Install: python -m pip install \"mcp>=1.0,<2\"",
    "# Run this file from an MCP client over stdio. Approve each session on the site.",
    "# This server deliberately has no shell or arbitrary command execution tools.",
    "import json",
    "import os",
    "import platform",
    "import sys",
    "import threading",
    "import urllib.request",
    "from pathlib import Path",
    "from mcp.server.fastmcp import FastMCP",
    "",
    "OWNER_NICK = " + JSON.stringify(ownerNick),
    "SERVER_ID = " + JSON.stringify(serverId),
    "SERVER_SECRET = " + JSON.stringify(serverSecret),
    "API_BASE = \"https://cheatlab.tatarhost.workers.dev/api/mcp\"",
    "SHARED_DIR = Path.home() / \"CheatLab-Shared\"",
    "ALLOWED_EXTENSIONS = {\".txt\", \".md\", \".json\", \".csv\", \".log\", \".py\", \".js\", \".ts\", \".html\", \".css\", \".yaml\", \".yml\", \".toml\"}",
    "MAX_FILE_BYTES = 256 * 1024",
    "POLL_SECONDS = 10",
    "",
    "SHARED_DIR.mkdir(parents=True, exist_ok=True)",
    "mcp = FastMCP(\"CHEATLAB PC — \" + OWNER_NICK)",
    "state = {\"status\": \"starting\"}",
    "state_lock = threading.Lock()",
    "stop_event = threading.Event()",
    "connection_id = None",
    "",
    "def api(method, path, payload=None):",
    "    data = None if payload is None else json.dumps(payload).encode(\"utf-8\")",
    "    headers = {\"Accept\": \"application/json\", \"X-CheatLab-MCP-Secret\": SERVER_SECRET, \"User-Agent\": \"CHEATLAB-MCP-PC/1.0\"}",
    "    if data is not None:",
    "        headers[\"Content-Type\"] = \"application/json\"",
    "    req = urllib.request.Request(API_BASE + path, data=data, headers=headers, method=method)",
    "    with urllib.request.urlopen(req, timeout=12) as response:",
    "        return json.loads(response.read(64 * 1024).decode(\"utf-8\"))",
    "",
    "def set_status(value):",
    "    with state_lock:",
    "        state[\"status\"] = value",
    "",
    "def current_status():",
    "    with state_lock:",
    "        return state[\"status\"]",
    "",
    "def require_approved():",
    "    if stop_event.is_set():",
    "        raise RuntimeError(\"CHEATLAB MCP session was stopped.\")",
    "    result = api(\"GET\", \"/agent/status/\" + connection_id)",
    "    value = result.get(\"status\", \"offline\")",
    "    set_status(value)",
    "    if value != \"approved\":",
    "        raise RuntimeError(\"MCP session is not approved or was disconnected (\" + value + \"). Approve it in CHEATLAB /mcp.\")",
    "",
    "def monitor_connection():",
    "    while not stop_event.wait(POLL_SECONDS):",
    "        try:",
    "            result = api(\"GET\", \"/agent/status/\" + connection_id)",
    "            value = result.get(\"status\", \"offline\")",
    "            set_status(value)",
    "            if value in {\"denied\", \"revoked\", \"disconnected\", \"expired\"}:",
    "                stop_event.set()",
    "                return",
    "        except Exception as exc:",
    "            set_status(\"offline\")",
    "            print(\"CHEATLAB MCP heartbeat failed: \" + str(exc), file=sys.stderr)",
    "",
    "def begin_connection():",
    "    result = api(\"POST\", \"/agent/connect\", {",
    "        \"deviceName\": \"PC (\" + platform.system() + \")\",",
    "        \"platform\": platform.system() + \" \" + platform.release(),",
    "        \"pythonVersion\": platform.python_version(),",
    "    })",
    "    return result[\"connectionId\"]",
    "",
    "@mcp.tool()",
    "def get_pc_info() -> dict:",
    "    \"\"\"Return basic, non-sensitive system information for this PC.\"\"\"",
    "    require_approved()",
    "    return {\"owner\": OWNER_NICK, \"platform\": platform.system(), \"platform_version\": platform.release(), \"python_version\": platform.python_version(), \"processor\": platform.processor()[:120], \"cpu_count\": os.cpu_count(), \"shared_folder\": str(SHARED_DIR)}",
    "",
    "@mcp.tool()",
    "def list_shared_files() -> list:",
    "    \"\"\"List supported files the owner placed in ~/CheatLab-Shared.\"\"\"",
    "    require_approved()",
    "    items = []",
    "    for path in sorted(SHARED_DIR.iterdir(), key=lambda item: item.name.lower()):",
    "        if path.is_symlink() or not path.is_file() or path.suffix.lower() not in ALLOWED_EXTENSIONS:",
    "            continue",
    "        try:",
    "            size = path.stat().st_size",
    "        except OSError:",
    "            continue",
    "        if size <= MAX_FILE_BYTES:",
    "            items.append({\"name\": path.name, \"size_bytes\": size})",
    "        if len(items) >= 100:",
    "            break",
    "    return items",
    "",
    "@mcp.tool()",
    "def read_shared_file(filename: str) -> str:",
    "    \"\"\"Read one text file from ~/CheatLab-Shared (256 KB maximum).\"\"\"",
    "    require_approved()",
    "    if not isinstance(filename, str) or not filename or Path(filename).name != filename:",
    "        raise ValueError(\"Provide a simple filename from the shared folder.\")",
    "    candidate = SHARED_DIR / filename",
    "    if candidate.is_symlink() or candidate.suffix.lower() not in ALLOWED_EXTENSIONS:",
    "        raise ValueError(\"This file type or path is not allowed.\")",
    "    root = SHARED_DIR.resolve()",
    "    resolved = candidate.resolve(strict=True)",
    "    if resolved.parent != root or not resolved.is_file():",
    "        raise ValueError(\"The file must be directly inside the shared folder.\")",
    "    if resolved.stat().st_size > MAX_FILE_BYTES:",
    "        raise ValueError(\"File is larger than 256 KB.\")",
    "    return resolved.read_text(encoding=\"utf-8\", errors=\"replace\")",
    "",
    "def main():",
    "    global connection_id",
    "    try:",
    "        connection_id = begin_connection()",
    "    except Exception as exc:",
    "        print(\"Could not register CHEATLAB MCP connection: \" + str(exc), file=sys.stderr)",
    "        raise SystemExit(1)",
    "    set_status(\"pending\")",
    "    print(\"CHEATLAB MCP request sent. Open https://cheatlab.fun/mcp and approve this PC.\", file=sys.stderr)",
    "    print(\"Shared folder: \" + str(SHARED_DIR), file=sys.stderr)",
    "    threading.Thread(target=monitor_connection, daemon=True).start()",
    "    try:",
    "        mcp.run(transport=\"stdio\")",
    "    finally:",
    "        stop_event.set()",
    "        try:",
    "            api(\"POST\", \"/agent/disconnect/\" + connection_id, {})",
    "        except Exception:",
    "            pass",
    "",
    "if __name__ == \"__main__\":",
    "    main()",
  ];
  return lines.join("\n") + "\n";
}

function downloadMcpPython(server, secret, nick) {
  const source = mcpPythonScript(nick, server.id, secret);
  const blob = new Blob([source], { type: "text/x-python;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "cheatlab_mcp_" + nick.replace(/[^A-Za-z0-9_-]/g, "_") + ".py";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return source;
}

export async function viewMcpPage({ $view, account, h, icon, api, toast, copy, when }) {
  if (!account) {
    $view.replaceChildren(
      h("div", { class: "page-head" }, h("h1", { text: "MCP для ПК" })),
      h("p", { class: "page-sub", text: "Войдите в CheatLab, чтобы создавать и контролировать подключения." }),
      h("a", { class: "btn btn-primary", href: "/auth" }, "Войти"),
    );
    return;
  }

  const page = h("section", { class: "mcp-page" });
  const name = h("input", { class: "input", maxlength: 40, value: account.nick + " · ПК", autocomplete: "off" });
  const error = h("p", { class: "form-error", role: "alert" });
  const generated = h("div", { class: "mcp-generated", hidden: true });
  const list = h("div", { class: "mcp-list" });
  let createButton;
  const refreshButton = h("button", { class: "btn", type: "button", onclick: () => refresh() }, icon("refresh", "i i-sm"), "Обновить");

  createButton = h("button", {
    class: "btn btn-primary", type: "button", onclick: async () => {
      createButton.disabled = true;
      error.textContent = "";
      try {
        const created = await api("/api/mcp/servers", { method: "POST", body: { name: name.value.trim() } });
        const source = downloadMcpPython(created.server, created.secret, account.nick);
        const copySecret = h("button", { class: "btn", type: "button", onclick: () => copy(created.secret, "Секрет скопирован") }, icon("copy", "i i-sm"), "Скопировать секрет");
        const downloadAgain = h("button", { class: "btn btn-primary", type: "button", onclick: () => downloadMcpPython(created.server, created.secret, account.nick) }, icon("download", "i i-sm"), "Скачать .py ещё раз");
        generated.hidden = false;
        generated.replaceChildren(
          h("h2", { text: "MCP создан · " + created.server.name }),
          h("p", { class: "hint", text: "Python-файл скачан. Секрет показывается только при создании — не отправляйте его другим людям." }),
          h("code", { class: "mcp-secret" }, created.secret),
          h("div", { class: "mcp-generated-actions" }, downloadAgain, copySecret),
          h("p", { class: "mcp-meta", text: "Скрипт: " + source.length.toLocaleString("ru-RU") + " символов · Python MCP · stdio" }),
        );
        await refresh();
      } catch (err) {
        error.textContent = err.message || "Не удалось создать MCP.";
      } finally {
        createButton.disabled = false;
      }
    },
  }, icon("plus", "i i-sm"), "Создать MCP и скачать Python");

  page.append(
    h("div", { class: "mcp-intro" },
      h("div", {},
        h("div", { class: "mcp-eyebrow", text: "CHEATLAB / LOCAL BRIDGE" }),
        h("h1", { text: "MCP для ПК" }),
        h("p", { text: "Подключайте локальный MCP-сервер к своему ИИ-клиенту. Каждая новая сессия появится здесь и будет ждать вашего подтверждения." }),
      ),
    ),
    h("div", { class: "mcp-create" },
      h("div", { class: "mcp-field" }, h("label", { text: "Название подключения" }), name),
      createButton,
    ),
    error,
    h("p", { class: "mcp-note", text: "До пяти MCP-серверов на аккаунт. Секрет хранится на сервере только в виде хеша; сам секрет включается в скачиваемый .py-файл." }),
    h("div", { class: "mcp-safety" },
      "Безопасность: скрипт не запускает команды и программы, не открывает терминал и не получает полный доступ к диску. ИИ видит только базовые сведения о системе и файлы, которые вы сами положите в ~/CheatLab-Shared. Новая сессия не работает до ручного одобрения.",
    ),
    generated,
    h("div", { class: "mcp-section-head" },
      h("h2", { text: "Ваши MCP-серверы" }),
      refreshButton,
    ),
    list,
  );
  $view.replaceChildren(page);

  async function refresh() {
    refreshButton.disabled = true;
    try {
      const data = await api("/api/mcp/servers");
      const servers = data.servers || [];
      createButton.disabled = servers.filter(server => !server.revoked).length >= 5;
      if (!servers.length) {
        list.replaceChildren(h("div", { class: "mcp-empty", text: "Пока нет MCP-подключений. Создайте первое выше." }));
        return;
      }
      const blocks = [];
      for (const server of servers) {
        const connData = await api("/api/mcp/servers/" + server.id + "/connections");
        const connections = connData.connections || [];
        const connRows = connections.map(connection => {
          const labels = {
            pending: "Ожидает подтверждения",
            approved: connection.online ? "Подключено" : "Нет сигнала",
            denied: "Отклонено", revoked: "Отключено",
            disconnected: "Завершено", expired: "Истекло",
          };
          const status = h("span", { class: "mcp-status is-" + connection.status, text: labels[connection.status] || connection.status });
          const meta = [connection.platform, connection.pythonVersion ? "Python " + connection.pythonVersion : "", connection.lastSeenAt ? "связь " + when(connection.lastSeenAt) : "запрос " + when(connection.createdAt)].filter(Boolean).join(" · ");
          const actions = h("div", { class: "mcp-actions" });
          if (connection.status === "pending") {
            actions.append(
              h("button", { class: "btn btn-primary", type: "button", onclick: () => connectionAction(connection.id, "approve") }, "Разрешить"),
              h("button", { class: "btn", type: "button", onclick: () => connectionAction(connection.id, "deny") }, "Отклонить"),
            );
          } else if (connection.status === "approved") {
            actions.append(h("button", { class: "btn", type: "button", onclick: () => connectionAction(connection.id, "revoke") }, "Отключить"));
          }
          return h("div", { class: "mcp-connection" },
            h("div", {},
              h("div", { class: "mcp-connection-name", text: connection.deviceName }),
              h("div", { class: "mcp-meta", text: meta }),
              status,
            ),
            actions,
          );
        });
        blocks.push(h("article", { class: "mcp-server" },
          h("div", { class: "mcp-server-head" },
            h("div", {},
              h("div", { class: "mcp-server-title", text: server.name }),
              h("div", { class: "mcp-meta", text: "ID " + server.id + " · секрет " + server.prefix + "… · создан " + when(server.createdAt) }),
              h("div", { class: "mcp-meta", text: server.revoked ? "Сервер отозван" : server.onlineCount + " активных · " + server.pendingCount + " ожидают" }),
            ),
            h("div", { class: "mcp-actions" },
              !server.revoked ? h("button", { class: "btn", type: "button", onclick: async () => {
                if (!window.confirm("Отозвать MCP-секрет и отключить все его сессии?")) return;
                try { await api("/api/mcp/servers/" + server.id, { method: "DELETE" }); await refresh(); }
                catch (err) { toast(err.message, true); }
              } }, "Отозвать сервер") : null,
            ),
          ),
          h("div", { class: "mcp-connection-list" },
            ...(connRows.length ? connRows : [h("div", { class: "mcp-empty", text: "Подключений пока не было." })]),
          ),
        ));
      }
      list.replaceChildren(...blocks);
    } catch (err) {
      list.replaceChildren(h("div", { class: "mcp-empty", text: err.message || "Не удалось загрузить список MCP." }));
    } finally {
      refreshButton.disabled = false;
    }
  }

  async function connectionAction(id, action) {
    try {
      if (action === "revoke") await api("/api/mcp/connections/" + id, { method: "DELETE" });
      else await api("/api/mcp/connections/" + id + "/" + action, { method: "POST" });
      await refresh();
    } catch (err) { toast(err.message || "Не удалось изменить подключение", true); }
  }

  await refresh();
}
