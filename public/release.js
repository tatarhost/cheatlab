/* CHEATLAB release notes and version policy.
   Bugfix: increment patch 11..99, then carry into minor and reset patch to 0.
   Feature release: increment minor and keep the patch sequence, e.g. 1.1.11 -> 1.2.11. */
(() => {
  const release = {
    version: '1.1.16',
    title: 'Обновление CHEATLAB',
    changes: [
      'Переработана мобильная компоновка: меньше горизонтальных вылетов и удобнее прокрутка.',
      'Поля и кнопки стали удобнее для нажатия на телефоне.',
      'Добавлено окно обновления с версией и списком изменений.',
      'В статистике появился общий счётчик скачиваний файлов.',
      'Frutiger Aero теперь основная тема CHEATLAB: стеклянные панели, водные оттенки и глянцевые элементы.'
    ]
  };
  const key = 'cheatlab.release.seen';
  try { if (localStorage.getItem(key) === release.version) return; } catch {}
  const backdrop = document.createElement('div');
  backdrop.className = 'cl-release-backdrop';
  backdrop.setAttribute('role', 'presentation');
  const dialog = document.createElement('section');
  dialog.className = 'cl-release-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'cl-release-title');
  const kicker = document.createElement('div');
  kicker.className = 'cl-release-kicker';
  kicker.textContent = 'CHEATLAB • ЧТО НОВОГО';
  const title = document.createElement('h2');
  title.className = 'cl-release-version';
  title.id = 'cl-release-title';
  title.textContent = 'Версия ' + release.version;
  const subtitle = document.createElement('p');
  subtitle.textContent = release.title;
  const list = document.createElement('ul');
  list.className = 'cl-release-list';
  for (const change of release.changes) {
    const item = document.createElement('li');
    item.textContent = change;
    list.appendChild(item);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'cl-release-close';
  close.textContent = 'Понятно';
  const dismiss = () => {
    try { localStorage.setItem(key, release.version); } catch {}
    backdrop.remove();
  };
  close.addEventListener('click', dismiss);
  backdrop.addEventListener('click', event => { if (event.target === backdrop) dismiss(); });
  dialog.append(kicker, title, subtitle, list, close);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  close.focus();
  document.addEventListener('keydown', function onKey(event) {
    if (event.key !== 'Escape') return;
    dismiss();
    document.removeEventListener('keydown', onKey);
  });
})();
