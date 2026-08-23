/* Клиент «Бункер». Логика синхронизации + рендер по состоянию с сервера. */
const socket = io();
const $ = id => document.getElementById(id);
let S = null; // последний state
let timerInterval = null;

const CAT_META = {
  gender:   { icon: 'Gender', name: 'Пол' },
  age:      { icon: 'Age', name: 'Возраст' },
  profession: { icon: 'Worker', name: 'Профессия' },
  health:   { icon: 'Heart', name: 'Здоровье' },
  hobby:    { icon: 'Guitar', name: 'Хобби' },
  phobia:   { icon: 'Ghost', name: 'Фобия' },
  baggage:  { icon: 'Luggage', name: 'Багаж' },
  fact:     { icon: 'Book', name: 'Факт биографии' },
  talent:   { icon: 'Sparkles', name: 'Талант' },
  action:   { icon: 'Crown', name: 'Козырь' }
};

// --- звук: короткие чиптюн-сигналы через WebAudio ---
let audioCtx = null;
function beep(freq, dur = 0.08, type = 'square', vol = 0.04) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq; g.gain.value = vol;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch (e) {}
}
const sfx = {
  round: () => { beep(392); setTimeout(() => beep(523), 120); },
  vote: () => beep(659),
  tick: () => beep(880, 0.03, 'square', 0.02),
  out: () => { beep(330); setTimeout(() => beep(220), 150); }
};

// --- утилиты ---
function toast(text) {
  const t = $('toast'); t.textContent = text; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 3500);
}
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
function saveSession(token, code, name) { localStorage.setItem('bunker_session', JSON.stringify({ token, code, name })); }
function loadSession() { try { return JSON.parse(localStorage.getItem('bunker_session')); } catch (e) { return null; } }

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $(id).classList.remove('hidden');
}

// --- вход ---
$('btn-create').onclick = () => {
  const name = $('inp-name').value.trim();
  if (!name) return $('join-error').textContent = 'Введите имя';
  socket.emit('create', { name }, res => {
    if (res.error) { $('join-error').textContent = res.error; return; }
    saveSession(res.token, res.code, name);
    window.history.replaceState(null, '', '?room=' + res.code);
  });
};
$('btn-join').onclick = () => {
  const name = $('inp-name').value.trim();
  const code = $('inp-code').value.trim().toUpperCase();
  if (!name) return $('join-error').textContent = 'Введите имя';
  if (!code) return $('join-error').textContent = 'Введите код комнаты';
  const sess = loadSession();
  socket.emit('join', { code, name, token: sess?.code === code ? sess.token : undefined }, res => {
    if (res.error) { $('join-error').textContent = res.error; return; }
    saveSession(res.token, res.code, name);
  });
};

// автоподключение по ссылке ?room=CODE и восстановление сессии
window.addEventListener('load', () => {
  const room = new URLSearchParams(location.search).get('room');
  if (room) $('inp-code').value = room.toUpperCase();
});
// восстановление после реконнекта
socket.on('connect', () => {
  const sess = loadSession();
  if (sess && !S) {
    socket.emit('join', { code: sess.code, name: sess.name, token: sess.token }, res => {
      if (res.error) localStorage.removeItem('bunker_session');
    });
  }
});

socket.on('kicked', () => {
  localStorage.removeItem('bunker_session');
  S = null;
  toast('Хост исключил вас из комнаты');
  showScreen('screen-join');
});

// --- главный рендер ---
socket.on('state', (state) => {
  const prevPhase = S?.phase;
  S = state;
  render(state);
  if (prevPhase !== state.phase) {
    if (state.phase === 'speech' && state.round > 0) sfx.round();
    if (state.phase === 'voting') sfx.vote();
  }
});

function render(st) {
  if (st.phase === 'lobby') showScreen('screen-lobby');
  else if (st.phase === 'scenario') showScreen('screen-scenario');
  else if (st.phase === 'finished') showScreen('screen-finish');
  else showScreen('screen-game');

  if (st.phase === 'lobby') renderLobby(st);
  if (st.phase === 'scenario') renderScenario(st);
  if (['speech', 'discussion', 'voting', 'voteResult'].includes(st.phase)) renderGame(st);
  if (st.phase === 'finished') renderFinish(st);
  renderChat(st, st.phase === 'lobby' ? 'chat-box' : 'chat-box-game');
  runTimer(st);
}

function playerRow(p, st, opts = {}) {
  const badges = [];
  if (p.isHost) badges.push('<span class="badge badge-host">ХОСТ</span>');
  if (opts.game) {
    badges.push(p.alive ? '' : '<span class="badge badge-dead">ВЫБЫЛ</span>');
    if (opts.speaking) badges.push('<span class="badge badge-speaker">ГОВОРИТ</span>');
  } else {
    badges.push(p.ready ? '<span class="badge badge-ready">ГОТОВ</span>' : '<span class="badge badge-notready">ЖДЁМ</span>');
  }
  if (!p.connected) badges.push('<span class="badge badge-notready">OFFLINE</span>');
  const kick = st.isHost && opts.kickable && !p.isHost ? `<button class="kick-btn" data-kick="${p.id}" title="Исключить">✕</button>` : '';
  return `<li><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <b>${esc(p.name)}</b>${badges.join('')}${kick}
  </div>${opts.game && !p.alive ? renderCards(p, true) : ''}</li>`;
}

function renderLobby(st) {
  $('room-code').textContent = st.code;
  $('room-link').textContent = location.origin + '/?room=' + st.code;
  $('room-link').onclick = () => { navigator.clipboard?.writeText(location.origin + '/?room=' + st.code); toast('Ссылка скопирована'); };
  $('player-list').innerHTML = st.players.map(p => playerRow(p, st, { kickable: true })).join('');
  document.querySelectorAll('[data-kick]').forEach(b => b.onclick = () => socket.emit('kick', b.dataset.kick));
  const me = st.players.find(p => p.id === st.meId);
  $('btn-ready').textContent = me?.ready ? 'Не готов' : 'Я готов';
  $('host-panel').classList.toggle('hidden', !st.isHost);
  // подставляем сохранённые настройки (если поле не в фокусе ввода)
  const setIfIdle = (id, v) => { const el = $(id); if (el && document.activeElement !== el && el.type !== 'checkbox' && el.type !== 'textarea') el.value = v; };
  if (st.isHost) {
    setIfIdle('set-rounds', st.settings.rounds);
    setIfIdle('set-survivors', st.settings.survivors || '');
    setIfIdle('set-speech', st.settings.speechTime);
    setIfIdle('set-discuss', st.settings.discussTime);
    if (document.activeElement !== $('set-scenario')) $('set-scenario').value = st.settings.customScenario || '';
    if (document.activeElement !== $('set-anon')) $('set-anon').checked = st.settings.anonymousVote;
  }
}

$('btn-ready').onclick = () => socket.emit('ready');
$('btn-save-settings').onclick = () => {
  socket.emit('settings', {
    rounds: +$('set-rounds').value, survivors: +$('set-survivors').value || null,
    speechTime: +$('set-speech').value, discussTime: +$('set-discuss').value,
    anonymousVote: $('set-anon').checked, customScenario: $('set-scenario').value
  }, r => r?.error ? toast(r.error) : toast('Настройки сохранены'));
};
$('btn-start').onclick = () => socket.emit('start', r => r?.error ? toast(r.error) : null);

// --- редактор колоды ---
$('btn-deck').onclick = () => {
  const ed = $('deck-editor');
  if (!ed.classList.contains('hidden')) { ed.classList.add('hidden'); return; }
  socket.emit('deck', res => {
    if (res.error) return toast(res.error);
    ed.classList.remove('hidden');
    const cats = { profession: 'Профессии', health: 'Здоровье', hobby: 'Хобби', phobia: 'Фобии', baggage: 'Багаж', fact: 'Факты', talent: 'Таланты', action: 'Козыри' };
    ed.innerHTML = Object.entries(cats).map(([k, n]) =>
      `<div class="cat"><label><b>${n}</b></label><textarea rows="5" data-cat="${k}">${esc(res.deck[k].join('\n'))}</textarea></div>`
    ).join('') + '<button id="btn-save-deck" class="btn">Сохранить колоду</button>';
    $('btn-save-deck').onclick = () => {
      const deck = {};
      ed.querySelectorAll('textarea').forEach(t => deck[t.dataset.cat] = t.value.split('\n').map(s => s.trim()).filter(Boolean));
      socket.emit('saveDeck', deck, r => r?.error ? toast(r.error) : toast('Колода сохранена'));
    };
  });
};

// --- сценарий ---
function renderScenario(st) {
  $('scenario-title').textContent = st.scenario?.title || '';
  $('scenario-text').textContent = st.scenario?.text || '';
  $('scenario-host').classList.toggle('hidden', !st.isHost);
}
$('btn-start-round').onclick = () => socket.emit('startRound');

// --- игра ---
function renderGame(st) {
  const alive = st.players.filter(p => p.alive).length;
  $('hud-round').textContent = `РАУНД ${st.round}/${st.totalRounds}`;
  $('hud-alive').textContent = `В БУНКЕРЕ: ${alive}`;
  $('hud-phase').textContent = { speech: 'Выступления', discussion: 'Обсуждение', voting: 'Голосование', voteResult: 'Итоги голосования' }[st.phase];
  $('hud-phase').className = 'hud';

  // панель игроков: живые сверху, зрители-персонажи раскрыты
  $('game-players').innerHTML = st.players.map(p => {
    const speaking = st.phase === 'speech' && p.id === st.speakerId;
    return `<div class="player-block ${speaking ? 'speaking' : ''}">
      <h4><b>${esc(p.name)}</b>
        ${p.isHost ? '<span class="badge badge-host">ХОСТ</span>' : ''}
        ${speaking ? '<span class="badge badge-speaker">ГОВОРИТ</span>' : ''}
        ${!p.alive ? '<span class="badge badge-dead">ВЫБЫЛ</span>' : ''}
      </h4>
      ${renderCards(p, p.id !== st.meId)}
    </div>`;
  }).join('');

  renderPhaseBox(st);
}

function renderCards(p, hideUnrevealed) {
  const me = S.players.find(x => x.id === S.meId);
  const myTurn = S.phase === 'speech' && S.speakerId === S.meId;
  const c = p.character;
  if (!c) return '';
  return Object.entries(CAT_META).filter(([k]) => k === 'gender' || k === 'age' || (c[k] && 'value' in c[k])).map(([k, meta]) => {
    if (k === 'gender' || k === 'age') {
      return `<div class="card"><span class="cat-icon">▪</span><div><div class="cat-name">${meta.name}</div><div class="cat-value">${esc(String(c[k]))}</div></div></div>`;
    }
    const card = c[k];
    const isAction = k === 'action';
    const visible = card.value !== null;
    const canReveal = myTurn && p.id === S.meId && !card.revealed && !isAction;
    const cls = 'card ' + (visible ? '' : 'hidden-card ') + (canReveal ? 'reveal-btn ' : '') + (isAction && S.actionUsed ? 'used' : '');
    return `<div class="${cls}" ${canReveal ? `data-reveal="${k}"` : ''}>
      <span class="cat-icon">▪</span>
      <div><div class="cat-name">${meta.name}</div><div class="cat-value">${visible ? esc(card.value) : '— закрыто —'}</div></div>
    </div>`;
  }).join('');
}

function renderPhaseBox(st) {
  const box = $('phase-box');
  const me = st.players.find(p => p.id === st.meId);
  const meAlive = me?.alive;

  if (st.phase === 'speech') {
    const sp = st.players.find(p => p.id === st.speakerId);
    let html = `<p class="big-hint">Выступает: <b>${esc(sp?.name)}</b> — раскрывает одну карту и убеждает остальных.</p>`;
    if (st.speakerId === st.meId && meAlive) {
      html += `<p class="sub">Нажмите на закрытую карту в своей панели (слева/сверху), чтобы раскрыть её.</p>`;
    }
    if (st.isHost) html += `<div class="row"><button id="btn-endspeech" class="btn">Завершить выступление</button></div>`;
    html += `<div class="row"><button id="btn-use-action" class="btn btn-ghost" ${st.actionUsed ? 'disabled' : ''}>${st.actionUsed ? 'Козырь использован' : 'Использовать козырь'}</button></div>`;
    box.innerHTML = html;
    $('btn-endspeech')?.addEventListener('click', () => socket.emit('endSpeech'));
    bindAction();
  }

  if (st.phase === 'discussion') {
    let html = `<p class="big-hint">Общее обсуждение. Убеждайте, спорьте, договаривайтесь в чате.</p>`;
    if (st.isHost) html += `<div class="row"><button id="btn-forcevote" class="btn btn-primary">Начать голосование</button></div>`;
    html += `<div class="row"><button id="btn-use-action" class="btn btn-ghost" ${st.actionUsed ? 'disabled' : ''}>${st.actionUsed ? 'Козырь использован' : 'Использовать козырь'}</button></div>`;
    box.innerHTML = html;
    $('btn-forcevote')?.addEventListener('click', () => socket.emit('forceVote'));
    bindAction();
  }

  if (st.phase === 'voting') {
    if (meAlive) {
      const myVote = Object.entries(st.votes).find(([v]) => v === st.meId)?.[1];
      let html = `<p class="big-hint">Голосование за исключение${st.settings.anonymousVote ? ' (анонимное)' : ''}. Выберите, кто покинет бункер:</p><div class="vote-grid">`;
      html += st.players.filter(p => p.alive && p.id !== st.meId).map(p =>
        `<div class="vote-card ${(selectedVote === p.id || myVote === p.id) ? 'selected' : ''}" data-vote="${p.id}">${esc(p.name)}</div>`).join('');
      html += `</div><div class="row"><button id="btn-confirm-vote" class="btn btn-primary">Подтвердить голос</button></div>`;
      box.innerHTML = html;
      document.querySelectorAll('[data-vote]').forEach(el => el.onclick = () => { selectVote(el.dataset.vote); });
      $('btn-confirm-vote').onclick = () => {
        if (!selectedVote) return toast('Сначала выберите игрока');
        socket.emit('vote', selectedVote, r => r?.error ? toast(r.error) : toast('Голос принят'));
      };
    } else {
      box.innerHTML = `<p class="big-hint">Вы зритель — наблюдаете за голосованием.</p>`;
    }
    if (st.isHost) {
      box.innerHTML += `<div class="row"><button id="btn-finishvote" class="btn">Подвести итоги досрочно</button></div>`;
      $('btn-finishvote').onclick = () => socket.emit('finishVote');
    }
    if (!st.settings.anonymousVote) {
      const voters = Object.entries(st.votes).map(([v, t]) => `${esc(st.players.find(p => p.id === v)?.name)} → ${esc(st.players.find(p => p.id === t)?.name)}`).join('; ');
      box.innerHTML += `<p class="sub">Проголосовали: ${voters || '—'}</p>`;
    }
  }

  if (st.phase === 'voteResult') {
    const last = st.eliminationLog[st.eliminationLog.length - 1];
    box.innerHTML = `<p class="big-hint">${last?.name ? `<b>${esc(last.name)}</b> покидает бункер! Его карты раскрыты.` : `Никто не выбыл (${esc(last?.tie || 'голоса разделились')}).`}</p>
      <p class="sub">Следующий этап начнётся автоматически…</p>`;
  }

  document.querySelectorAll('[data-reveal]').forEach(el => el.onclick = () => {
    socket.emit('reveal', el.dataset.reveal, r => r?.error ? toast(r.error) : beep(523));
  });

  function bindAction() {
    $('btn-use-action')?.addEventListener('click', () => socket.emit('useAction', r => r?.error ? toast(r.error) : null));
  }
}

let selectedVote = null;
function selectVote(id) {
  selectedVote = id;
  document.querySelectorAll('[data-vote]').forEach(el => el.classList.toggle('selected', el.dataset.vote === id));
}
// --- таймер ---
function runTimer(st) {
  clearInterval(timerInterval);
  const el = $('hud-timer');
  if (!['speech', 'discussion', 'voting'].includes(st.phase)) { el.textContent = '--'; el.classList.remove('low'); return; }
  const offset = Date.now() - st.timer.serverNow;
  const end = st.timer.endsAt + offset;
  let lastSec = null;
  timerInterval = setInterval(() => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    const m = Math.floor(left / 60), s = left % 60;
    el.textContent = `${st.timer.label}: ${m}:${String(s).padStart(2, '0')}`;
    el.classList.toggle('low', left <= 10);
    if (left <= 5 && left !== lastSec && left > 0) { sfx.tick(); lastSec = left; }
    if (left === 0) clearInterval(timerInterval);
  }, 250);
}

// --- чат ---
function renderChat(st, boxId) {
  const box = $(boxId); if (!box) return;
  box.innerHTML = st.chat.map(m => m.system
    ? `<div class="chat-msg system">— ${esc(m.text)}</div>`
    : `<div class="chat-msg"><span class="who">${esc(m.name)}:</span> ${esc(m.text)}</div>`).join('');
  box.scrollTop = box.scrollHeight;
}
function bindChat(inputId, sendId) {
  $(sendId).onclick = () => { const v = $(inputId).value.trim(); if (v) { socket.emit('chat', v); $(inputId).value = ''; } };
  $(inputId).addEventListener('keydown', e => { if (e.key === 'Enter') $(sendId).click(); });
}
bindChat('chat-input', 'chat-send');
bindChat('chat-input-game', 'chat-send-game');

// --- финал ---
function renderFinish(st) {
  const survivors = st.players.filter(p => p.alive);
  $('finish-list').innerHTML = survivors.map(p => `
    <div class="player-block"><h4><b>${esc(p.name)}</b> <span class="badge badge-ready">ВЫЖИЛ</span></h4>${renderCards(p, false)}</div>
  `).join('');
  $('finish-log').innerHTML = st.eliminationLog.map(e =>
    `<div class="log-item">Раунд ${e.round}: ${e.name ? `<b>${esc(e.name)}</b> выбыл` : `никто не выбыл (${esc(e.tie || 'ничья')})`} — голоса: ${
      Object.entries(e.voters).map(([t, vs]) => `${esc(t)} ← ${vs.map(esc).join(', ')}`).join(' | ') || '—'}</div>`
  ).join('') || '<p class="sub">Голосований не было.</p>';
  $('finish-host').classList.toggle('hidden', !st.isHost);
}
$('btn-lobby-again').onclick = () => socket.emit('backToLobby');
