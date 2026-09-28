/**
 * CHEATLAB publisher widget.
 *
 * Drop-in for any site, no build step and no account:
 *
 *   <script src="https://your-cheatlab-host/embed.js"
 *           data-api="https://your-cheatlab-host"
 *           data-site="https://your-cheatlab-site"
 *           data-target="#publish"
 *           defer></script>
 *
 * Optional attributes:
 *   data-api      API origin (required)
 *   data-site      site origin for follow-up links, when it differs from data-api
 *   data-target   CSS selector for the element to render into (default: auto-mount)
 *   data-language preselected language
 *   data-label    button label (default: "В CHEATLAB")
 *
 * The widget talks to the public API directly, so the host page needs no server
 * and no credentials: identity comes from the same device id the site already
 * keeps in localStorage, and the edit key is handed straight back to the author.
 */
(function () {
  'use strict';

  const script = document.currentScript || (function () {
    const all = document.getElementsByTagName('script');
    return all[all.length - 1];
  })();

  const API = (script && script.dataset.api) || script && script.src.replace(/\/embed\.js.*$/, '') || '';
  // Where the reader lands when they follow a published link. Separate from the
  // API origin whenever the site and the Worker sit on different hosts.
  const SITE = (script && script.dataset.site) || API;
  const TARGET = (script && script.dataset.target) || '';
  const LABEL = (script && script.dataset.label) || 'В CHEATLAB';
  const LANG = (script && script.dataset.language) || 'text';
  const STORE = 'cheatlab.keys';
  const ID_STORE = 'cheatlab.client';

  if (!API) {
    console.warn('[cheatlab] embed.js: задайте data-api с адресом инсталляции CHEATLAB');
    return;
  }

  const TYPES = [
    ['script', 'Скрипт', 'M8 17 3 12l5-5m3 3 6 6M9 12l3-3'],
    ['app', 'Приложение', 'M21 8l-9-5-9 5 9 5 9-5M3 8v8l9 5 9-5V8M12 13v8'],
    ['paste', 'Паста', 'M9 4h6v3H9M7 5H5v15h14V5h-2M9 12h6M9 16h4'],
    ['image', 'Изображение', 'M3 3h18v18H3zM9 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2M21 15l-5-5-9 9'],
    ['video', 'Видео', 'M15 10l5-3v10l-5-3M3 6h12v12H3z'],
    ['file', 'Файл', 'M15 2v4h4M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2z'],
  ];

  function clientId() {
    let id = localStorage.getItem(ID_STORE);
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      const raw = crypto.getRandomValues(new Uint8Array(24));
      id = btoa(String.fromCharCode.apply(null, raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      localStorage.setItem(ID_STORE, id);
    }
    return id;
  }

  function svg(path, cls) {
    return '<svg class="' + cls + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + path + '"/></svg>';
  }

  function el(tag, cls, html) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function style() {
    if (document.getElementById('cheatlab-embed-style')) return;
    const css = document.createElement('style');
    css.id = 'cheatlab-embed-style';
    css.textContent = [
      '.clx{box-sizing:border-box;font:14px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;',
      'color:#0b0b0b;max-width:520px}',
      '.clx *{box-sizing:border-box}',
      '.clx-title{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:#6f6f6f;margin:0 0 12px}',
      '.clx-tabs{display:flex;border:1px solid #0b0b0b}',
      '.clx-tab{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px;',
      'background:#fff;border:0;border-right:1px solid #0b0b0b;cursor:pointer;font:500 12px/1 inherit}',
      '.clx-tab:last-child{border-right:0}',
      '.clx-tab[aria-selected="true"]{background:#0b0b0b;color:#fff}',
      '.clx svg{width:16px;height:16px;flex:none}',
      '.clx label{display:block;margin:14px 0 6px;font:500 11px/1 inherit;letter-spacing:.09em;',
      'text-transform:uppercase;color:#6f6f6f}',
      '.clx input,.clx textarea{width:100%;padding:8px 10px;border:1px solid #d4d4d4;border-radius:0;',
      'background:#fff;font:14px/1.5 inherit;color:#0b0b0b}',
      '.clx textarea{font:13px/1.6 ui-monospace,Consolas,monospace;min-height:150px;resize:vertical}',
      '.clx input:focus,.clx textarea:focus{border-color:#0b0b0b;outline:0}',
      '.clx-row{display:flex;gap:8px;margin-top:16px}',
      '.clx-btn{flex:1;padding:9px 14px;border:1px solid #0b0b0b;border-radius:0;background:#0b0b0b;',
      'color:#fff;font:500 12px/1 inherit;letter-spacing:.04em;text-transform:uppercase;cursor:pointer}',
      '.clx-btn[disabled]{opacity:.5;cursor:progress}',
      '.clx-btn-ghost{flex:0 0 auto;background:#fff;color:#0b0b0b}',
      '.clx-note{margin:14px 0 0;padding:10px 12px;border:1px solid #0b0b0b;font:12px/1.5 ui-monospace,Consolas,monospace;',
      'word-break:break-all;background:#f2f2f2}',
      /* deslop-ignore-next-line 09 link inside the note, not decoration */
      '.clx-note a{text-decoration:underline}',
      '.clx-err{border-color:#0b0b0b;border-width:2px;background:#fff}',
    ].join('');
    document.head.appendChild(css);
  }

  function showNote(text, bad) {
    note.textContent = text;
    note.className = 'clx-note' + (bad ? ' clx-err' : '');
    note.style.display = '';
  }

  function mount() {
    style();
    const host = TARGET ? document.querySelector(TARGET) : document.querySelector('.cheatlab-embed');
    if (!host) return console.warn('[cheatlab] не найден контейнер для виджета:', TARGET || '.cheatlab-embed');

    let type = 'script';
    const root = el('div', 'clx');
    root.append(el('p', 'clx-title', 'Опубликовать в CHEATLAB'));

    const tabs = el('div', 'clx-tabs');
    TYPES.forEach(function (t) {
      const b = el('button', 'clx-tab', svg(t[2], '') + t[1]);
      b.type = 'button';
      b.setAttribute('aria-selected', t[0] === type);
      b.addEventListener('click', function () {
        type = t[0];
        for (const other of tabs.children) other.setAttribute('aria-selected', other === b);
        lang.value = type === 'script' ? 'luau' : 'text';
      });
      tabs.append(b);
    });
    root.append(tabs);

    const titleLabel = el('label', '', 'Название');
    const title = el('input');
    title.placeholder = 'Что это';
    root.append(titleLabel, title);

    const langLabel = el('label', '', 'Язык');
    const lang = el('input');
    lang.value = LANG;
    root.append(langLabel, lang);

    const bodyLabel = el('label', '', 'Код или текст');
    const body = el('textarea');
    body.spellcheck = false;
    body.placeholder = 'Вставь содержимое';
    root.append(bodyLabel, body);

    const tagsLabel = el('label', '', 'Теги');
    const tags = el('input');
    tags.placeholder = 'через запятую';
    root.append(tagsLabel, tags);

    const send = el('button', 'clx-btn', 'Опубликовать');
    send.type = 'button';
    const open = el('a', 'clx-btn clx-btn-ghost', 'Открыть');
    open.target = '_blank';
    open.rel = 'noopener';
    open.style.display = 'none';
    const row = el('div', 'clx-row');
    row.append(send, open);
    root.append(row);

    const note = el('p', 'clx-note');
    note.style.display = 'none';
    root.append(note);

    const prefill = host.dataset.content || host.textContent || '';
    if (prefill.trim()) body.value = prefill.trim();
    if (host.dataset.title) title.value = host.dataset.title;

    send.addEventListener('click', async function () {
      if (!title.value.trim()) { title.focus(); return showNote('Нужно название', true); }
      send.disabled = true;
      send.textContent = 'Публикация...';
      try {
        const res = await fetch(API + '/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-cheatlab-client': clientId() },
          body: JSON.stringify({
            type: type,
            title: title.value.trim(),
            language: lang.value.trim() || 'text',
            tags: tags.value.split(/[,\s]+/).filter(Boolean),
            body: body.value,
            visibility: 'public',
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);

        const keys = JSON.parse(localStorage.getItem(STORE) || '{}');
        keys[data.item.id] = data.secret;
        localStorage.setItem(STORE, JSON.stringify(keys));

        open.href = SITE + '/i/' + data.item.id;
        open.style.display = '';
        send.textContent = 'Опубликовано';
        showNote('Ссылка: ' + SITE + '/i/' + data.item.id + '  Ключ: ' + data.secret, false);
      } catch (err) {
        send.disabled = false;
        send.textContent = 'Опубликовать';
        showNote(err.message, true);
      }
    });

    host.replaceChildren(root);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
