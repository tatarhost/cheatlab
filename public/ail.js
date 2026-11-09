const API=(document.querySelector('meta[name="cheatlab-api"]')?.content||'').replace(/\/+$/,'');
const $=id=>document.getElementById(id);
const session=(()=>{try{return JSON.parse(localStorage.getItem('cheatlab.session')||'null')}catch{return null}})();
function clientId(){let id=localStorage.getItem('cheatlab.client');if(!id||!/^[A-Za-z0-9_-]{16,64}$/.test(id)){const b=crypto.getRandomValues(new Uint8Array(24));id=btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');localStorage.setItem('cheatlab.client',id)}return id}
const headers=()=>({'content-type':'application/json','x-cheatlab-client':clientId(),...(session?.token?{'x-cheatlab-session':session.token}:{})});
async function api(path,opts={}){const r=await fetch(API+path,{...opts,headers:{...headers(),...(opts.headers||{})},cache:'no-store'});const d=await r.json().catch(()=>({error:'Ответ API не JSON'}));if(!r.ok)throw Error(d.error||'HTTP '+r.status);return d}
function bubble(role,text){const el=document.createElement('div');el.className='bubble '+role;const meta=document.createElement('span');meta.className='meta';meta.textContent=role==='user'?'Вы':'AIL AI · Preview';const body=document.createElement('div');body.textContent=text;el.append(meta,body);$('messages').append(el);$('messages').scrollTop=$('messages').scrollHeight;return el}
let history=[];
$('chatForm').addEventListener('submit',async e=>{e.preventDefault();const message=$('prompt').value.trim();if(!message)return;if(!session?.token){location.href='./auth';return}bubble('user',message);$('prompt').value='';$('send').disabled=true;const pending=bubble('assistant','Думаю…');try{const d=await api('/api/ail/chat',{method:'POST',body:JSON.stringify({message,history})});pending.lastChild.textContent=d.answer;history.push({role:'user',content:message},{role:'assistant',content:d.answer});history=history.slice(-10)}catch(err){pending.lastChild.textContent='Ошибка: '+err.message}finally{$('send').disabled=false;$('prompt').focus()}});
$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('chatForm').requestSubmit()}});
$('clearChat').addEventListener('click',()=>{history=[];$('messages').replaceChildren();const w=document.createElement('div');w.className='welcome';w.innerHTML='<b>AIL AI</b><p>Диалог очищен. Задай новый вопрос.</p>';$('messages').append(w)});
async function status(){try{const d=await api('/api/ail/status');$('inferenceState').textContent=d.inference.available?'Доступен':'Недоступен';$('modelName').textContent=d.inference.model+' · базовая модель';$('trainingState').textContent=d.training.connected?'Подключён':'Не подключён';$('trainingDetail').textContent=d.training.message;$('honestyNotice').textContent=d.training.message+' Сейчас чат работает через Workers AI; это ещё не собственная обученная модель AIL.';$('honestyNotice').className='notice '+(d.training.connected?'good':'')}catch(e){$('inferenceState').textContent='Ошибка API';$('trainingState').textContent='Нет данных';$('honestyNotice').textContent=e.message}}
async function loadKeys(){if(!session?.token){$('keyList').textContent='Войдите в CHEATLAB, чтобы управлять ключами.';return}try{const d=await api('/api/ail/keys');$('keyList').replaceChildren();if(!d.keys.length){$('keyList').textContent='Ключей пока нет.';return}for(const k of d.keys){const row=document.createElement('div');row.className='key-row';const b=document.createElement('button');b.textContent='Отозвать';b.addEventListener('click',async()=>{if(!confirm('Отозвать этот API-ключ?'))return;try{await api('/api/ail/keys/'+k.id,{method:'DELETE'});loadKeys()}catch(e){alert(e.message)}});const strong=document.createElement('strong');strong.textContent=k.label+' · '+k.prefix+'…';const span=document.createElement('span');span.textContent=k.revoked?'Отозван':k.unlimited?'Без срока (администратор)':('До '+new Date(k.expiresAt).toLocaleString());row.append(b,strong,span);$('keyList').append(row)}}catch(e){$('keyList').textContent=e.message}}
$('keyForm').addEventListener('submit',async e=>{e.preventDefault();if(!session?.token){location.href='./auth';return}try{const d=await api('/api/ail/keys',{method:'POST',body:JSON.stringify({label:$('keyLabel').value.trim()})});$('newKey').hidden=false;$('newKey').replaceChildren();const code=document.createElement('code');code.textContent=d.key;const note=document.createElement('p');note.textContent=d.item.unlimited?'Администраторский ключ без срока действия.':'Ключ действует 10 дней. Скопируйте его сейчас — повторно показать его нельзя.';const copy=document.createElement('button');copy.textContent='Копировать ключ';copy.addEventListener('click',()=>navigator.clipboard.writeText(d.key));$('newKey').append(code,note,copy);$('keyLabel').value='';loadKeys()}catch(e){alert(e.message)}});
status();loadKeys();setInterval(status,15000);

async function loadTrainingDashboard(){
 const statusEl=$('ailTrainStatus');if(!statusEl)return;
 try{
  const d=await api('/api/ail/status');
  const t=d.training||{},m=t.latest;
  statusEl.textContent=t.status==='session_completed'?'СЕССИЯ ЗАВЕРШЕНА':t.status==='session_failed'?'СЕССИЯ С ОШИБКОЙ':t.status==='not_started'?'ОЖИДАНИЕ':'СОСТОЯНИЕ ОБУЧЕНИЯ';
  $('ailTrainSteps').textContent=Number(m?.totalSteps||t.step||0).toLocaleString('ru-RU');
  $('ailTrainParams').textContent=Number(m?.parameters||0).toLocaleString('ru-RU');
  $('ailTrainLoss').textContent=Number.isFinite(Number(m?.validationLoss))?Number(m.validationLoss).toFixed(4):'—';
  $('ailTrainUpdated').textContent=m?.createdAt?'Cloudflare · '+new Date(m.createdAt).toLocaleString('ru-RU'):'Ожидание первой сессии';
  $('ailTrainNote').textContent=t.message+' Checkpoint восстанавливается между отдельными сессиями GitHub Actions; цель 1 млрд параметров пока не достигнута.';
  if(t.sessions?.length) drawLossHistory(t.sessions);
  const a=document.querySelector('.run-link');if(a)a.href='https://github.com/tatarhost/cheatlab/actions/workflows/ail-cpu-training.yml';
 }catch(e){statusEl.textContent='СТАТУС НЕДОСТУПЕН';$('ailTrainNote').textContent='Не удалось получить статистику из Cloudflare: '+e.message;}
}
function drawLossHistory(sessions){
 const root=$('ailLossChart');if(!root)return;
 const vals=sessions.slice().reverse().filter(x=>Number.isFinite(Number(x.validationLoss))).map(x=>Number(x.validationLoss));
 if(!vals.length){root.innerHTML='<div class="chart-empty">История появится после регистрации первой сессии в Cloudflare</div>';return;}
 const min=Math.min(...vals),max=Math.max(...vals),span=Math.max(.001,max-min);
 const pts=vals.map((v,i)=>({x:4+(i/Math.max(1,vals.length-1))*92,y:92-((v-min)/span)*72}));
 const path=pts.map((p,i)=>(i?'L':'M')+p.x+','+p.y).join(' ');
 root.innerHTML='<svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="История validation loss"><path d="'+path+'" fill="none" stroke="#8ac5ff" stroke-width="2.5" vector-effect="non-scaling-stroke"/>'+pts.map(p=>'<circle cx="'+p.x+'" cy="'+p.y+'" r="1.8" fill="#7ee0b1"/>').join('')+'</svg>';
}
function drawLoss(m){
 const root=$('ailLossChart');if(!root)return;
 const vals=[Number(m.train_loss),Number(m.validation_loss),Number(m.best_validation_loss)].filter(Number.isFinite);
 if(!vals.length)return;
 const min=Math.min(...vals),max=Math.max(...vals),span=Math.max(.001,max-min);
 const pts=vals.map((v,i)=>({x:8+i*42,y:92-((v-min)/span)*72}));
 const path=pts.map((p,i)=>(i?'L':'M')+p.x+','+p.y).join(' ');
 root.innerHTML='<svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Последние значения ошибки"><path d="'+path+'" fill="none" stroke="#8ac5ff" stroke-width="2.5" vector-effect="non-scaling-stroke"/>'+pts.map(p=>'<circle cx="'+p.x+'" cy="'+p.y+'" r="2.2" fill="#7ee0b1"/>').join('')+'</svg>';
}
loadTrainingDashboard();setInterval(loadTrainingDashboard,60000);
