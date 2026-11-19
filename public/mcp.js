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

  function showEndpoint(title, url) {
    generated.hidden = false;
    const endpoint = h("code", { class: "mcp-secret" }, url);
    generated.replaceChildren(
      h("h2", { text: title }),
      h("p", { class: "mcp-note", text: "Это секретная ссылка доступа. Она показывается один раз. Не публикуйте её и не отправляйте посторонним." }),
      endpoint,
      h("div", { class: "mcp-generated-actions" },
        h("button", {
          class: "btn btn-primary", type: "button",
          onclick: () => copy(url, "Адрес MCP скопирован"),
        }, icon("copy", "i i-sm"), "Скопировать адрес"),
      ),
      h("p", { class: "mcp-meta", text: "Транспорт: MCP Streamable HTTP · обработка запросов: серверы CHEATLAB" }),
    );
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
        showEndpoint("Удалённый MCP готов · " + created.server.name, created.remoteUrl);
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
      "Всё выполняется на серверах CHEATLAB. На компьютере не нужно устанавливать Python, открывать консоль или держать запущенный процесс. Секрет URL хранится в базе только как SHA-256-хеш; полный URL показывается при создании или перевыпуске.",
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
      h("p", { class: "mcp-note", text: "Удалённый MCP открывает ИИ только данные твоего аккаунта CHEATLAB: сведения об аккаунте, список публикаций, поиск и чтение собственных публикаций. Все инструменты в этой версии доступны только для чтения; команды компьютера и доступ к чужим аккаунтам отсутствуют." }),
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
      const blocks = servers.map(server => h("article", { class: "mcp-server" },
        h("div", { class: "mcp-server-head" },
          h("div", {},
            h("div", { class: "mcp-server-title", text: server.name }),
            h("div", { class: "mcp-meta", text: "ID " + server.id + " · создан " + when(server.createdAt) }),
            h("div", { class: "mcp-meta", text: server.revoked
              ? "Сервер отозван"
              : (server.remoteReady ? "Удалённый адрес активен · ключ " + server.remotePrefix + "…" : "Удалённый адрес ещё не создан") }),
            h("div", { class: "mcp-meta", text: "Последний запрос: " + formatTime(server.remoteLastUsedAt, when) }),
          ),
          h("div", { class: "mcp-actions" },
            !server.revoked ? h("button", {
              class: "btn btn-primary", type: "button",
              onclick: () => rotateEndpoint(server),
            }, server.remoteReady ? "Новый адрес" : "Создать адрес") : null,
            !server.revoked ? h("button", {
              class: "btn", type: "button", onclick: () => revokeServer(server),
            }, "Отозвать") : null,
          ),
        ),
      ));
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
