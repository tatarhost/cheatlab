/* CHEATLAB creator studio: single-file site and Discord.js starter generator. */
(() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const s = { kind:'site', title:'Мой проект', desc:'Небольшой проект, созданный в CHEATLAB.', color:'#8b7cff', bot:'MyCheatLabBot', prefix:'!' };
  let back, panel;
  function siteCode() {
    const title=esc(s.title||'Мой сайт'), desc=esc(s.desc||'Добро пожаловать!');
    const color=/^#[0-9a-f]{6}$/i.test(s.color)?s.color:'#8b7cff';
    return '<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title><meta name="description" content="'+desc+'"><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 15% 10%,'+color+'55,transparent 36%),#090b12;color:#f7f7fb;font:16px/1.6 system-ui,sans-serif}main{width:min(760px,100%);padding:clamp(28px,7vw,64px);border:1px solid #ffffff26;border-radius:28px;background:#ffffff0d;backdrop-filter:blur(22px);box-shadow:0 30px 100px #0008}small{color:'+color+';font-weight:700;letter-spacing:.14em;text-transform:uppercase}h1{font-size:clamp(36px,8vw,64px);line-height:1.05;letter-spacing:-.05em;margin:18px 0}p{color:#c7cad4;max-width:58ch}.button{display:inline-block;margin-top:18px;padding:12px 20px;border-radius:999px;background:'+color+';color:#080911;text-decoration:none;font-weight:700}</style></head><body><main><small>Мой проект</small><h1>'+title+'</h1><p>'+desc+'</p><a class="button" href="mailto:hello@example.com">Связаться</a></main></body></html>';
  }
  function botCode() {
    return '// '+(s.bot||'MyBot')+' — безопасный стартовый Discord-бот\n// Установка: npm install discord.js\n// Запуск: DISCORD_TOKEN="токен" node bot.js\n// Никогда не публикуй токен бота и не вставляй его в этот файл.\n\nconst { Client, GatewayIntentBits } = require("discord.js");\nconst client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });\nconst PREFIX = '+JSON.stringify(s.prefix||'!')+';\n\nclient.once("ready", () => console.log("Бот запущен:", client.user.tag));\nclient.on("messageCreate", async (message) => {\n  if (message.author.bot || !message.content.startsWith(PREFIX)) return;\n  const [command] = message.content.slice(PREFIX.length).trim().split(/\s+/);\n  if (command === "ping") await message.reply("Pong! 🏓");\n  else if (command === "help") await message.reply("Команды: "+PREFIX+"ping, "+PREFIX+"help");\n});\nconst token = process.env.DISCORD_TOKEN;\nif (!token) { console.error("Задай DISCORD_TOKEN в переменных окружения."); process.exit(1); }\nclient.login(token);\n';
  }
  const source=()=>s.kind==='site'?siteCode():botCode();
  function download(){
    const url=URL.createObjectURL(new Blob([source()],{type:'text/plain;charset=utf-8'}));
    const a=document.createElement('a'); a.href=url; a.download=s.kind==='site'?'index.html':'bot.js'; a.click(); URL.revokeObjectURL(url);
  }
  function inviteUrl(){
    const id=String(s.clientId||'').trim();
    if(!/^\\d{17,20}$/.test(id)) return '';
    const q=new URLSearchParams({client_id:id,scope:'bot applications.commands',permissions:'68608'});
    return 'https://discord.com/oauth2/authorize?'+q.toString();
  }
  function render(){
    const isSite=s.kind==='site';
    const invite=inviteUrl();
    panel.innerHTML='<div class="cl-create-head"><h2>Конструктор CHEATLAB</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Закрыть">×</button></div>'+
      '<div class="cl-create-tabs"><button class="cl-create-tab" data-kind="site" aria-selected="'+isSite+'">Свой сайт</button><button class="cl-create-tab" data-kind="bot" aria-selected="'+(!isSite)+'">Discord-бот</button></div>'+
      '<div class="cl-create-grid"><div class="cl-create-fields">'+(isSite?
      '<label class="field"><span class="label">Название сайта</span><input class="input" data-field="title" maxlength="70" value="'+esc(s.title)+'"></label><label class="field"><span class="label">Описание</span><textarea class="textarea" data-field="desc" rows="4" maxlength="220">'+esc(s.desc)+'</textarea></label><label class="field"><span class="label">Основной цвет</span><input type="color" data-field="color" value="'+esc(s.color)+'"></label><p class="cl-create-note">Готовая адаптивная HTML-страница с glass-дизайном. Скачай index.html или опубликуй исходник в CHEATLAB.</p>':
      '<div class="cl-create-note"><b>Шаг 1. Создай приложение Discord</b><p>Нажми кнопку ниже. Discord откроет форму нового приложения — придумай имя и подтверди создание.</p><a class="btn btn-primary" href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Открыть Discord Developer Portal ↗</a></div>'+
      '<div class="cl-create-note"><b>Шаг 2. Создай бота и скопируй Client ID</b><p>В приложении открой раздел Bot и нажми Add Bot. Затем в OAuth2 → General скопируй Application ID (Client ID).</p><label class="field"><span class="label">Client ID (только цифры)</span><input class="input" inputmode="numeric" data-field="clientId" maxlength="20" placeholder="Например, 123456789012345678" value="'+esc(s.clientId)+'"></label>'+
      '<b>Шаг 3. Пригласи бота на сервер</b><p>Ссылка создаётся локально из Client ID. CHEATLAB не получает твой токен.</p><button class="btn btn-primary" type="button" data-invite '+(invite?'':'disabled')+'>Открыть ссылку приглашения ↗</button>'+
      '<b>Шаг 4. Получи токен и запусти</b><p>В Bot → Reset Token создай токен и скопируй его. Включи Message Content Intent, если хочешь команды с префиксом. Токен не вставляй в CHEATLAB, чат или исходный код — задай его как секрет <code>DISCORD_TOKEN</code> на своём хостинге.</p>'+
      '<label class="field"><span class="label">Имя бота в проекте</span><input class="input" data-field="bot" maxlength="50" value="'+esc(s.bot)+'"></label><label class="field"><span class="label">Префикс команд</span><input class="input" data-field="prefix" maxlength="4" value="'+esc(s.prefix)+'"></label><p class="cl-create-note">CHEATLAB подготовит исходник Discord.js. Сам сайт не запускает постоянные процессы и не хранит токены.</p>')+
      '<div class="cl-create-actions"><button class="btn btn-primary" data-download>Скачать '+(isSite?'index.html':'bot.js')+'</button><button class="btn" data-publish>Опубликовать исходник в CHEATLAB</button></div></div><div class="cl-create-preview">'+(isSite?'<iframe title="Предпросмотр сайта" sandbox="allow-same-origin"></iframe>':'<div style="padding:18px"><strong>Предпросмотр команд</strong><p class="hint">'+esc(s.prefix)+'ping → Pong! 🏓</p><p class="hint">'+esc(s.prefix)+'help → список команд</p><pre class="cl-create-code" data-code></pre></div>')+'</div></div>';
    if(isSite) panel.querySelector('iframe').srcdoc=source(); else panel.querySelector('[data-code]').textContent=source();
  }
  function close(){back?.remove();panel?.remove();back=panel=null;}
  function open(){
    if(panel)return;
    back=document.createElement('div');back.className='cl-create-back';
    panel=document.createElement('section');panel.className='cl-create';panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
    document.body.append(back,panel);back.addEventListener('click',close);
    panel.addEventListener('click',e=>{
      const b=e.target.closest('button');if(!b)return;
      if(b.dataset.close!==undefined)return close();
      if(b.dataset.kind){s.kind=b.dataset.kind;return render();}
      if(b.dataset.download!==undefined)return download();
      if(b.dataset.invite!==undefined){const url=inviteUrl();if(url)window.open(url,'_blank','noopener,noreferrer');return;}
      if(b.dataset.publish!==undefined){
        try{localStorage.setItem('cheatlab.creatorDraft',JSON.stringify({title:s.kind==='site'?s.title:s.bot,body:source(),language:s.kind==='site'?'html':'javascript',type:'app'}));}catch{}
        close();location.href='./new?type=app&creator=1';
      }
    });
    panel.addEventListener('input',e=>{
      const k=e.target.dataset.field;if(!k)return;s[k]=e.target.value;
      const frame=panel.querySelector('iframe');if(frame)frame.srcdoc=source();
      const code=panel.querySelector('[data-code]');if(code)code.textContent=source();
      const inviteButton=panel.querySelector('[data-invite]');if(inviteButton)inviteButton.disabled=!inviteUrl();
    });
    render();
  }
  function mount(){
    // Publish action is owned by index.html and stays outside the app layout.
    const nav=document.querySelector('.nav');if(!nav||nav.querySelector('[data-creators]'))return;
    const b=document.createElement('button');b.type='button';b.className='nav-link';b.dataset.creators='1';b.innerHTML='<svg class="i" aria-hidden="true"><use href="#i-box"/></svg>Создать';b.addEventListener('click',open);
    const after=nav.querySelector('[data-studio]');after?after.after(b):nav.append(b);
  }
  document.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();
