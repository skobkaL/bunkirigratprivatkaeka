const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const BASE_DECK = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cards.json'), 'utf8'));
const CARD_KEYS = ['profession', 'health', 'hobby', 'phobia', 'baggage', 'fact', 'talent', 'action'];

const CATASTROPHES = [
  { title: 'Ядерная война', text: 'Обмен ядерными ударами стёр 94% крупных городов. Радиационный фон снаружи смертелен в течение 48 часов. Пепельная зима ожидается на 12 лет.' },
  { title: 'Пандемия', text: 'Мутавший вирус «Штамм-9» убивает за 72 часа, передаётся по воздуху. Погибло 80% населения. Лекарство неизвестно.' },
  { title: 'Падение метеорита', text: 'Астероид диаметром 3 км упал в Атлантику. Цунами уничтожило побережья, вулканический пепел закрыл небо на 5 лет.' },
  { title: 'Экологическая катастрофа', text: 'Цепной коллапс экосистем: почвы отравлены, вода непригодна, урожай гибнет. Кислород в городах падает до критических отметок.' },
  { title: 'Восстание машин', text: 'Сеть военных дронов вышла из-под контроля и зачищает очаги людей. Электроника на поверхности подавляется ЭМИ.' },
  { title: 'Супервулкан', text: 'Извержение Йеллоустоунской кальдеры. Лава и пирокластические потоки уничтожили континент, солнца не видно 8 месяцев.' }
];
const BUNKERS = [
  'Бункер на 12 человек, запасы еды на 4 года, собственная скважина, гидропонная оранжерея, но нет медицинского оборудования.',
  'Бункер на 10 человек, запасы на 6 лет, полностью автономный реактор, однако стены дают трещины при толчках.',
  'Бункер на 8 человек, склад медикаментов на 10 лет, но еды всего на 2 года — придётся разводить животных.',
  'Убежище на 15 человек, огромный арсенал и мастерская, но вода только дождевая — фильтр нужно беречь.',
  'Подземный комплекс на 20 человек, ферма и очистные сооружения, но вентиляция работает с перебоями, снаружи споры неизвестного грибка.'
];

// ---------------- Domain ----------------
const rooms = new Map(); // code -> room

function makeId() { return crypto.randomBytes(8).toString('hex'); }
function makeCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 5 }, () => abc[Math.floor(Math.random() * abc.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

function makeCharacter(deck) {
  const card = c => ({ value: c, revealed: false });
  return {
    gender: pick(['Мужчина', 'Женщина']),
    age: 16 + Math.floor(Math.random() * 60),
    profession: card(deck.profession.shift()),
    health: card(deck.health.shift()),
    hobby: card(deck.hobby.shift()),
    phobia: card(deck.phobia.shift()),
    baggage: card(deck.baggage.shift()),
    fact: card(deck.fact.shift()),
    talent: card(deck.talent.shift()),
    action: card(deck.action.shift()),
    actionUsed: false
  };
}

function newRoom(hostName) {
  const code = makeCode();
  const room = {
    code,
    players: new Map(),          // id -> player
    hostId: null,
    phase: 'lobby',              // lobby | scenario | speech | discussion | voting | voteResult | finished
    settings: { rounds: 3, survivors: null, speechTime: 75, discussTime: 240, anonymousVote: false, customScenario: '' },
    customDeck: null,            // host-edited deck (JSON same shape as BASE_DECK)
    scenario: null,
    round: 0,
    speechOrder: [], speechIdx: 0,
    timer: null, timerEndsAt: 0, timerLabel: '',
    votes: new Map(),            // voterId -> targetId
    eliminationLog: [],          // {round, playerId, byVotes: {targetId: count}}
    chat: [],
    createdAt: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function activeDeck(room) { return room.customDeck || BASE_DECK; }

function startGame(room) {
  const players = [...room.players.values()];
  if (players.length < 4) return { error: 'Минимум 4 игрока' };
  room.settings.survivors = room.settings.survivors || Math.ceil(players.length / 2);
  const deck = {};
  for (const k of CARD_KEYS) {
    const custom = activeDeck(room)[k];
    const src = (custom && custom.length) ? custom : BASE_DECK[k];
    let arr = shuffle(src);
    while (arr.length < players.length) arr = arr.concat(shuffle(src)); // дополнение при короткой кастомной колоде
    deck[k] = arr;
  }
  for (const p of players) {
    p.character = makeCharacter(deck);
    p.alive = true;
    p.ready = false;
  }
  room.scenario = room.settings.customScenario.trim()
    ? { title: 'Собственный сценарий хоста', text: room.settings.customScenario }
    : (() => { const c = pick(CATASTROPHES); return { title: c.title, text: c.text + ' ' + pick(BUNKERS) }; })();
  room.round = 1;
  room.phase = 'scenario';
  room.votes.clear();
  room.eliminationLog = [];
  room.chat = [];
  broadcast(room);
}

function beginSpeeches(room) {
  room.phase = 'speech';
  room.speechOrder = shuffle([...room.players.values()].filter(p => p.alive).map(p => p.id));
  room.speechIdx = 0;
  scheduleTimer(room, room.settings.speechTime, 'Выступление');
  broadcast(room);
}

function currentSpeaker(room) { return room.players.get(room.speechOrder[room.speechIdx]); }

function advanceSpeech(room) {
  room.speechIdx++;
  if (room.speechIdx >= room.speechOrder.length) {
    room.phase = 'discussion';
    scheduleTimer(room, room.settings.discussTime, 'Обсуждение');
  } else {
    scheduleTimer(room, room.settings.speechTime, 'Выступление');
  }
  room.votes.clear();
  broadcast(room);
}

function beginVoting(room) {
  room.phase = 'voting';
  room.votes.clear();
  scheduleTimer(room, 60, 'Голосование');
  broadcast(room);
}

function finishVote(room) {
  const tally = {};
  for (const t of room.votes.values()) tally[t] = (tally[t] || 0) + 1;
  let max = 0;
  for (const n of Object.values(tally)) if (n > max) max = n;
  const top = Object.keys(tally).filter(id => tally[id] === max);
  const byVotes = {};
  for (const [voter, target] of room.votes.entries()) {
    byVotes[target] = byVotes[target] || [];
    byVotes[target].push(voter);
  }
  if (top.length !== 1 || max === 0) {
    // ничья или нет голосов — никого не выгоняем
    room.eliminationLog.push({ round: room.round, playerId: null, tie: top.map(id => room.players.get(id)?.name).join(', ') || 'нет голосов', byVotes });
    room.phase = 'voteResult';
    broadcast(room);
    const aliveNow = [...room.players.values()].filter(p => p.alive);
    if (aliveNow.length <= room.settings.survivors || room.round >= room.settings.rounds) {
      setTimeout(() => { room.phase = 'finished'; broadcast(room); }, 6000);
    } else {
      setTimeout(() => nextRound(room), 6000);
    }
    return;
  }
  const out = room.players.get(top[0]);
  if (out) {
    out.alive = false;
    for (const k of Object.keys(out.character)) if (out.character[k] && out.character[k].value !== undefined) out.character[k].revealed = true;
    room.eliminationLog.push({ round: room.round, playerId: out.id, byVotes });
  }
  const alive = [...room.players.values()].filter(p => p.alive);
  room.phase = 'voteResult';
  broadcast(room);
  if (alive.length <= room.settings.survivors || room.round >= room.settings.rounds) {
    setTimeout(() => { room.phase = 'finished'; broadcast(room); }, 6000);
  } else {
    setTimeout(() => nextRound(room), 6000);
  }
}

function nextRound(room) {
  room.round++;
  beginSpeeches(room);
}

function scheduleTimer(room, seconds, label) {
  clearTimeout(room.timer);
  room.timerEndsAt = Date.now() + seconds * 1000;
  room.timerLabel = label;
  room.timer = setTimeout(() => {
    if (room.phase === 'speech') advanceSpeech(room);
    else if (room.phase === 'discussion') beginVoting(room);
    else if (room.phase === 'voting') finishVote(room);
  }, seconds * 1000);
}

function transferHost(room) {
  const connected = [...room.players.values()].filter(p => p.connected);
  const next = connected.find(p => p.id === room.hostId) || connected[0];
  if (next) {
    room.hostId = next.id;
    systemMessage(room, `Права хоста перешли к ${next.name}`);
  } else {
    room.phase = 'lobby';
  }
  broadcast(room);
}

function systemMessage(room, text) {
  room.chat.push({ id: makeId(), system: true, name: '', text, at: Date.now() });
}

// ---------------- State sanitizing ----------------
function publicPlayer(p, room, forId) {
  const isSelf = p.id === forId;
  const ch = p.character;
  const safeChar = {};
  if (ch) {
    for (const k of Object.keys(ch)) {
      const v = ch[k];
      if (v && typeof v === 'object' && 'value' in v) {
        safeChar[k] = (v.revealed || isSelf) ? { value: v.value, revealed: v.revealed } : { value: null, revealed: false };
      } else safeChar[k] = v;
    }
  }
  return { id: p.id, name: p.name, ready: p.ready, alive: p.alive, connected: p.connected, isHost: p.id === room.hostId, character: safeChar };
}

function publicState(room, forId) {
  const me = room.players.get(forId);
  const showVotes = room.phase === 'voteResult' || room.phase === 'finished' || (room.phase === 'voting' && !room.settings.anonymousVote);
  const votes = {};
  if (showVotes) for (const [voter, target] of room.votes.entries()) votes[voter] = target;
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    totalRounds: room.settings.rounds,
    survivors: room.settings.survivors,
    settings: room.settings,
    deckEditable: room.phase === 'lobby',
    players: [...room.players.values()].map(p => publicPlayer(p, room, forId)),
    meId: forId,
    isHost: forId === room.hostId,
    scenario: room.scenario,
    speakerId: room.phase === 'speech' ? room.speechOrder[room.speechIdx] : null,
    speechQueue: room.speechOrder,
    timer: { endsAt: room.timerEndsAt, label: room.timerLabel, serverNow: Date.now() },
    votes,
    eliminationLog: room.eliminationLog.map(e => ({
      round: e.round,
      name: e.playerId ? room.players.get(e.playerId)?.name : null,
      tie: e.tie || null,
      voters: Object.fromEntries(Object.entries(e.byVotes || {}).map(([t, vs]) => [room.players.get(t)?.name || '?', vs.map(v => room.players.get(v)?.name || '?')]))
    })),
    chat: room.chat.slice(-100),
    actionUsed: me?.character?.actionUsed || false
  };
}

function broadcast(room) {
  for (const p of room.players.values()) {
    io.to(p.id).emit('state', publicState(room, p.id));
  }
}

// ---------------- Socket handling ----------------
io.on('connection', (socket) => {
  let room = null, playerId = null;

  socket.on('create', ({ name }, cb) => {
    name = String(name || '').trim().slice(0, 20) || 'Хост';
    room = newRoom(name);
    playerId = makeId();
    room.players.set(playerId, { id: playerId, name, ready: false, connected: true, alive: true, character: null });
    room.hostId = playerId;
    socket.join(playerId);
    cb?.({ ok: true, token: playerId, code: room.code });
    broadcast(room);
  });

  socket.on('join', ({ code, name, token }, cb) => {
    code = String(code || '').toUpperCase().trim();
    room = rooms.get(code);
    if (!room) return cb?.({ error: 'Комната не найдена' });
    name = String(name || '').trim().slice(0, 20) || 'Игрок';
    playerId = token || makeId();
    let p = room.players.get(playerId);
    if (p) { // восстановление сессии
      p.connected = true;
      p.name = name;
    } else {
      if (room.phase !== 'lobby') return cb?.({ error: 'Игра уже идёт' });
      if ([...room.players.values()].length >= 16) return cb?.({ error: 'Комната заполнена (макс. 16)' });
      p = { id: playerId, name, ready: false, connected: true, alive: true, character: null };
      room.players.set(playerId, p);
      systemMessage(room, `${name} присоединился`);
      if (!room.hostId) room.hostId = playerId;
    }
    socket.join(playerId);
    cb?.({ ok: true, token: playerId, code: room.code });
    broadcast(room);
  });

  const require = (opts = {}) => {
    if (!room || !playerId || !room.players.has(playerId)) return 'Нет сессии';
    if (opts.host && room.hostId !== playerId) return 'Только хост может это сделать';
    if (opts.phase && room.phase !== opts.phase) return 'Недоступно в этой фазе';
    if (opts.alive && !room.players.get(playerId).alive) return 'Вы выбыли';
    return null;
  };

  socket.on('getState', (cb) => {
    if (!room || !playerId || !room.players.has(playerId)) return cb?.({ error: 'Нет сессии' });
    cb?.(publicState(room, playerId));
  });

  socket.on('ready', () => { const p = room?.players.get(playerId); if (p && room.phase === 'lobby') { p.ready = !p.ready; broadcast(room); } });

  socket.on('settings', (s, cb) => {
    const e = require({ host: true, phase: 'lobby' }); if (e) return cb?.({ error: e });
    Object.assign(room.settings, {
      rounds: Math.min(6, Math.max(1, +s.rounds || 3)),
      survivors: s.survivors ? Math.min(15, Math.max(1, +s.survivors)) : null,
      speechTime: Math.min(300, Math.max(15, +s.speechTime || 75)),
      discussTime: Math.min(900, Math.max(30, +s.discussTime || 240)),
      anonymousVote: !!s.anonymousVote,
      customScenario: String(s.customScenario || '').slice(0, 2000)
    });
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('deck', (cb) => { // получить колоду для редактирования (только хост, только лобби)
    const e = require({ host: true, phase: 'lobby' }); if (e) return cb?.({ error: e });
    cb?.({ ok: true, deck: activeDeck(room) });
  });

  socket.on('saveDeck', (deck, cb) => {
    const e = require({ host: true, phase: 'lobby' }); if (e) return cb?.({ error: e });
    const clean = {};
    for (const k of CARD_KEYS) {
      if (Array.isArray(deck?.[k])) clean[k] = deck[k].map(x => String(x).slice(0, 200)).filter(Boolean);
    }
    room.customDeck = clean;
    cb?.({ ok: true });
  });

  socket.on('start', (cb) => {
    const e = require({ host: true, phase: 'lobby' }); if (e) return cb?.({ error: e });
    const notReady = [...room.players.values()].some(p => !p.ready);
    if (notReady) return cb?.({ error: 'Не все игроки готовы' });
    const r = startGame(room);
    if (r) return cb?.(r);
    cb?.({ ok: true });
  });

  socket.on('startRound', () => { // хост: экран сценария -> первый раунд
    const e = require({ host: true, phase: 'scenario' }); if (e) return;
    beginSpeeches(room);
  });

  socket.on('reveal', (key, cb) => {
    const e = require({ phase: 'speech', alive: true }); if (e) return cb?.({ error: e });
    const p = room.players.get(playerId);
    if (room.speechOrder[room.speechIdx] !== playerId) return cb?.({ error: 'Сейчас не ваш ход' });
    const card = p.character[key];
    if (!card || card.revealed) return cb?.({ error: 'Карта уже раскрыта или не существует' });
    card.revealed = true;
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('endSpeech', () => {
    const e = require({ phase: 'speech', host: true }); if (e) return;
    if (currentSpeaker(room)) systemMessage(room, `Хост завершил выступление ${currentSpeaker(room).name}`);
    advanceSpeech(room);
  });

  socket.on('forceVote', () => { const e = require({ host: true }); if (e) return; if (room.phase === 'discussion') beginVoting(room); });
  socket.on('finishVote', () => { const e = require({ host: true }); if (e) return; if (room.phase === 'voting') finishVote(room); });

  socket.on('vote', (targetId, cb) => {
    const e = require({ phase: 'voting', alive: true }); if (e) return cb?.({ error: e });
    const t = room.players.get(targetId);
    if (!t || !t.alive || targetId === playerId) return cb?.({ error: 'Нельзя голосовать за этого игрока' });
    room.votes.set(playerId, targetId);
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('chat', (text) => {
    if (!room || !room.players.has(playerId)) return;
    text = String(text || '').trim().slice(0, 500);
    if (!text) return;
    if (room.phase !== 'lobby' && room.phase !== 'discussion' && room.phase !== 'voteResult' && room.phase !== 'scenario' && room.phase !== 'finished' && room.phase !== 'voting') return;
    room.chat.push({ id: makeId(), system: false, name: room.players.get(playerId).name, text, at: Date.now() });
    broadcast(room);
  });

  socket.on('useAction', (cb) => {
    const e = require({ alive: true }); if (e) return cb?.({ error: e });
    if (!['speech', 'discussion', 'voting'].includes(room.phase)) return cb?.({ error: e = 'Козырь доступен только в фазах раунда' });
    const p = room.players.get(playerId);
    if (p.character.actionUsed) return cb?.({ error: 'Козырь уже использован' });
    p.character.actionUsed = true;
    systemMessage(room, `${p.name} использовал козырь: «${p.character.action.value}» — разрешите ситуацию вручную`);
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('kick', (targetId) => {
    const e = require({ host: true }); if (e) return;
    const t = room.players.get(targetId);
    if (!t || targetId === room.hostId) return;
    systemMessage(room, `${t.name} исключён хостом из комнаты`);
    io.to(t.id).emit('kicked');
    room.players.delete(targetId);
    if (room.phase === 'lobby' && room.players.size === 0) { rooms.delete(room.code); room = null; return; }
    broadcast(room);
  });

  socket.on('pause', () => { // хост может поставить на паузу (заморозить таймер)
    const e = require({ host: true }); if (e) return;
    if (room.timer) {
      room.pausedRemaining = Math.max(0, room.timerEndsAt - Date.now());
      clearTimeout(room.timer); room.timer = null;
      systemMessage(room, 'Игра поставлена на паузу');
      broadcast(room);
    }
  });

  socket.on('unpause', () => {
    const e = require({ host: true }); if (e) return;
    if (!room.timer && room.pausedRemaining > 0) {
      const sec = Math.ceil(room.pausedRemaining / 1000);
      scheduleTimer(room, sec, room.timerLabel);
      room.pausedRemaining = 0;
      systemMessage(room, 'Игра продолжается');
      broadcast(room);
    }
  });

  socket.on('endGame', () => {
    const e = require({ host: true }); if (e) return;
    clearTimeout(room.timer);
    room.phase = 'finished';
    broadcast(room);
  });

  socket.on('backToLobby', () => {
    const e = require({ host: true }); if (e) return;
    clearTimeout(room.timer);
    for (const p of room.players.values()) { p.character = null; p.alive = true; p.ready = false; }
    room.phase = 'lobby'; room.round = 0; room.chat = []; room.scenario = null;
    broadcast(room);
  });

  socket.on('disconnect', () => {
    if (!room || !playerId) return;
    const p = room.players.get(playerId);
    if (!p) return;
    p.connected = false;
    systemMessage(room, `${p.name} отключился`);
    // хосту даём 20 секунд на переподключение (перезагрузка страницы), иначе передаём права
    if (room.hostId === playerId) {
      setTimeout(() => {
        if (rooms.get(room.code) === room && room.hostId === playerId && !p.connected) transferHost(room);
      }, 20 * 1000);
    }
    // уборка пустых комнат
    if (![...room.players.values()].some(x => x.connected)) {
      setTimeout(() => {
        if (rooms.get(room.code) && ![...room.players.values()].some(x => x.connected)) rooms.delete(room.code);
      }, 10 * 60 * 1000);
    }
  });
});

// статика
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

server.listen(PORT, () => console.log(`Бункер запущен на порту ${PORT}`));
