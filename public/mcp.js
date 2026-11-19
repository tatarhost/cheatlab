const formatTime = (value, when) => Number(value) > 0 ? when(Number(value)) : "ещё не использовался";

export async function viewMcpPage({ $view, account, h, icon, api, toast, copy, when }) {
  if (!account) {
    $view.replaceChildren(
      h("div", { class: "page-head" }, h("h1", { text: "MCP для ИИ" })),
      h("p", { class: "page-sub", text: "Войдите в CHEATLAB, чтобы создать удалённый MCP-сервер." }),
      h("a", { class: "btn btn-primary", href: "/auth" }, "Войти"),
    );
    return;
  }

  const page = h("section", { class: "mcp-page" });
  const name = h("input", {
    class: "input", maxlength: 40, value: account.nick + " · MCP",
    autocomplete: "off", spellcheck: false,
  });
  const error = h("p", { class: "form-error", role: "alert" });
  const generated = h("div", { class: "mcp-generated", hidden: true });
  const list = h("div", { class: "mcp-list" });
  const refreshButton = h("button", {
    class: "btn", type: "button", onclick: () => refresh(),
  }, icon("refresh", "i i-sm"), "Обновить");
  let createButton;

  function showEndpoint(title, url, pcCode = "") {
    generated.hidden = false;
    const content = [h("h2", { text: title })];
    if (pcCode) {
      content.push(
        h("p", { class: "mcp-note", text: "Код для Windows EXE. Вставьте его в CHEATLAB PC Bridge. Полный код показывается один раз — сохраните его." }),
        h("code", { class: "mcp-secret", text: pcCode }),
        h("div", { class: "mcp-generated-actions" },
          h("button", { class: "btn btn-primary", type: "button", onclick: () => copy(pcCode, "Код подключения ПК скопирован") },
            icon("copy", "i i-sm"), "Скопировать код ПК"),
        ),
      );
    }
    if (url) {
      content.push(
        h("p", { class: "mcp-note", text: "Секретная ссылка туннеля для ИИ. Добавьте её в MCP-клиент и никому не пересылайте." }),
        h("code", { class: "mcp-secret", text: url }),
        h("div", { class: "mcp-generated-actions" },
          h("button", { class: "btn btn-primary", type: "button", onclick: () => copy(url, "Адрес MCP скопирован") },
            icon("copy", "i i-sm"), "Скопировать AI MCP URL"),
        ),
      );
    }
    content.push(
      h("p", { class: "mcp-meta", text: "Транспорт: MCP Streamable HTTP · туннель: серверы CHEATLAB · команды ПК отключены" }),
      h("a", { href: "https://github.com/tatarhost/cheatlab/actions/workflows/pc-bridge-exe.yml", target: "_blank", rel: "noopener noreferrer" },
        "Скачать CHEATLAB PC Bridge (Windows EXE) из последней сборки"),
    );
    generated.replaceChildren(...content);
    generated.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }

  createButton = h("button", {
    class: "btn btn-primary", type: "button",
    onclick: async () => {
      createButton.disabled = true;
      error.textContent = "";
      try {
        const created = await api("/api/mcp/servers", {
          method: "POST", body: { name: name.value.trim() },
        });
        showEndpoint("Подключение готово · " + created.server.name, created.remoteUrl, created.secret);
        await refresh();
      } catch (err) {
        error.textContent = err.message || "Не удалось создать MCP-сервер.";
      } finally {
        createButton.disabled = false;
      }
    },
  }, icon("plus", "i i-sm"), "Создать удалённый MCP");

  page.append(
    h("div", { class: "mcp-intro" },
      h("div", {},
        h("div", { class: "mcp-eyebrow", text: "CHEATLAB / REMOTE MCP" }),
        h("h1", { text: "MCP для ИИ" }),
        h("p", { text: "Один удалённый адрес для ChatGPT и других приложений, которые умеют подключаться к MCP по Streamable HTTP." }),
      ),
    ),
    h("div", { class: "mcp-create" },
      h("div", { class: "mcp-field" },
        h("label", { text: "Название подключения" }), name,
      ),
      createButton,
    ),
    error,
    h("div", { class: "mcp-safety" },
      "Для ПК скачайте Windows EXE и вставьте в него код подключения. После запуска подтвердите запрос на этой странице. ИИ получает доступ только к сведениям о системе и текстовым файлам в папке CheatLab-Shared; терминал, запуск программ и произвольный доступ к диску отсутствуют.",
    ),
    h("section", { class: "mcp-install" },
      h("h2", { text: "Подключение к ChatGPT" }),
      h("ol", {},
        h("li", {}, "Откройте настройки ChatGPT и включите Developer mode, если эта функция доступна вашему аккаунту."),
        h("li", {}, "Перейдите в раздел Apps / Plugins и выберите добавление собственного MCP-сервера."),
        h("li", {}, "Вставьте скопированный адрес CHEATLAB. Для такого URL выберите подключение без дополнительной авторизации: секрет уже находится в адресе."),
        h("li", {}, "Создайте приложение и выберите его в чате через меню инструментов Developer mode."),
      ),
      h("p", { class: "mcp-note", text: "ChatGPT поддерживает удалённые MCP-серверы по SSE и Streaming HTTP. Доступность Developer mode зависит от плана и настроек рабочего пространства; если этого пункта нет, подключите адрес в другом MCP-клиенте." }),
      h("a", { href: "https://developers.openai.com/api/docs/guides/developer-mode", target: "_blank", rel: "noopener noreferrer" }, "Документация ChatGPT Developer mode"),
    ),
    h("section", { class: "mcp-install" },
      h("h2", { text: "Поддерживаемые возможности" }),
      h("p", { class: "mcp-note", text: "MCP объединяет данные твоего аккаунта CHEATLAB и подтверждённого ПК: сведения о системе, список файлов и чтение .txt/.md/.json/.csv из папки CheatLab-Shared (до 64 КБ на файл). Нет доступа к командной строке, запуску программ, изменению файлов или всему диску." }),
    ),
    generated,
    h("div", { class: "mcp-section-head" },
      h("h2", { text: "Ваши MCP-серверы" }),
      refreshButton,
    ),
    list,
  );
  $view.replaceChildren(page);

  async function rotateEndpoint(server) {
    try {
      const result = await api("/api/mcp/servers/" + server.id + "/remote-key", { method: "POST" });
      showEndpoint("Новый адрес MCP · " + server.name, result.remoteUrl);
      await refresh();
    } catch (err) {
      toast(err.message || "Не удалось создать адрес MCP", true);
    }
  }

  async function rotatePcKey(server) {
    if (!window.confirm("Перевыпустить код подключения ПК для «" + server.name + "»? Все текущие подключения этого компьютера будут отключены.")) return;
    try {
      const result = await api("/api/mcp/servers/" + server.id + "/pc-key", { method: "POST" });
      showEndpoint("Новый код подключения ПК · " + server.name, "", result.secret);
      await refresh();
    } catch (err) {
      toast(err.message || "Не удалось перевыпустить код ПК", true);
    }
  }

  async function connectionAction(connection, action) {
    try {
      if (action === "disconnect") {
        await api("/api/mcp/connections/" + connection.id, { method: "DELETE" });
      } else {
        await api("/api/mcp/connections/" + connection.id + "/" + action, { method: "POST" });
      }
      await refresh();
    } catch (err) {
      toast(err.message || "Не удалось изменить подключение ПК", true);
    }
  }

  async function revokeServer(server) {
    if (!window.confirm("Отозвать адрес MCP «" + server.name + "»? Все приложения с этим адресом сразу потеряют доступ.")) return;
    try {
      await api("/api/mcp/servers/" + server.id, { method: "DELETE" });
      await refresh();
    } catch (err) {
      toast(err.message || "Не удалось отозвать MCP-сервер", true);
    }
  }

  async function refresh() {
    refreshButton.disabled = true;
    try {
      const data = await api("/api/mcp/servers");
      const servers = data.servers || [];
      createButton.disabled = servers.filter(server => !server.revoked).length >= 5;
      if (!servers.length) {
        list.replaceChildren(h("div", {
          class: "mcp-empty",
          text: "Пока нет MCP-серверов. Создайте первый выше.",
        }));
        return;
      }
      const blocks = await Promise.all(servers.map(async server => {
        let connections = [];
        if (!server.revoked) {
          try {
            const info = await api("/api/mcp/servers/" + server.id + "/connections");
            connections = info.connections || [];
          } catch { /* server metadata remains visible */ }
        }
        const connectionNodes = connections.length
          ? connections.map(connection => h("div", { class: "mcp-meta" },
              h("span", { text: connection.deviceName + " · " + connection.platform + " · " +
                (connection.status === "pending" ? "ожидает подтверждения" :
                 connection.status === "approved" ? (connection.online ? "подключён" : "не в сети") :
                 connection.status) }),
              h("div", { class: "mcp-actions" },
                connection.status === "pending" ? h("button", {
                  class: "btn btn-primary", type: "button",
                  onclick: () => connectionAction(connection, "approve"),
                }, "Разрешить") : null,
                connection.status === "pending" ? h("button", {
                  class: "btn", type: "button",
                  onclick: () => connectionAction(connection, "deny"),
                }, "Отклонить") : null,
                connection.status === "approved" ? h("button", {
                  class: "btn", type: "button",
                  onclick: () => connectionAction(connection, "disconnect"),
                }, "Отключить") : null,
              ),
            ))
          : [h("div", { class: "mcp-meta", text: "Подключённых ПК пока нет" })];
        return h("article", { class: "mcp-server" },
          h("div", { class: "mcp-server-head" },
            h("div", {},
              h("div", { class: "mcp-server-title", text: server.name }),
              h("div", { class: "mcp-meta", text: "ID " + server.id + " · создан " + when(server.createdAt) }),
              h("div", { class: "mcp-meta", text: server.revoked
                ? "Сервер отозван"
                : (server.remoteReady ? "AI MCP-туннель активен · ключ " + server.remotePrefix + "…" : "AI MCP-туннель не создан") }),
              h("div", { class: "mcp-meta", text: "Последний запрос ИИ: " + formatTime(server.remoteLastUsedAt, when) }),
              h("div", { class: "mcp-meta", text: "Код ПК: " + server.prefix + "… (хранится в виде хеша)" }),
            ),
            h("div", { class: "mcp-actions" },
              !server.revoked ? h("button", {
                class: "btn btn-primary", type: "button", onclick: () => rotateEndpoint(server),
              }, server.remoteReady ? "Новый AI URL" : "Создать AI URL") : null,
              !server.revoked ? h("button", {
                class: "btn", type: "button", onclick: () => rotatePcKey(server),
              }, "Новый код ПК") : null,
              !server.revoked ? h("button", {
                class: "btn", type: "button", onclick: () => revokeServer(server),
              }, "Отозвать всё") : null,
            ),
          ),
          h("div", { class: "mcp-connections" },
            h("div", { class: "mcp-server-title", text: "Подключения компьютеров" }),
            ...connectionNodes,
          ),
        );
      }));
      list.replaceChildren(...blocks);
    } catch (err) {
      list.replaceChildren(h("div", {
        class: "mcp-empty", text: err.message || "Не удалось загрузить список MCP-серверов.",
      }));
    } finally {
      refreshButton.disabled = false;
    }
  }

  await refresh();
}
