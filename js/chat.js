/* Чат Kick только для чтения: подключение к Pusher (как сайт kick.com), смайлы Kick и 7TV */
(function () {
  'use strict';
  var h = U.h;

  var MAX_LINES = 50;
  // публичный ключ Pusher сайта kick.com
  var PUSHER = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';
  var DEFAULT_COLORS = ['#53FC18', '#FF6B6B', '#4FC3F7', '#FFD54F', '#BA68C8', '#FF8A65', '#4DB6AC', '#F06292',
    '#AED581', '#9575CD', '#E57373', '#64B5F6', '#FFB74D', '#81C784', '#7986CB'];

  var Chat = {
    ws: null, channel: null, chatroomId: null, el: null, list: null, state: null,
    queue: [], flushTimer: null, retry: 0, active: false, emotes: {}
  };

  Chat.init = function () {
    Chat.el = U.$('#chat');
    Chat.list = U.$('.chat-list', Chat.el);
    Chat.state = U.$('.chat-state', Chat.el);
  };

  Chat.start = function (login) {
    login = String(login || '').toLowerCase();
    if (Chat.active && Chat.channel === login) return;
    Chat.stop();
    Chat.active = true;
    Chat.channel = login;
    Chat.chatroomId = null;
    Chat.list.innerHTML = '';
    Chat.retry = 0;
    Chat.emotes = {};
    Chat.system(tr('Подключение к чату…'), 'chat-connecting');
    // номер чат-комнаты и id пользователя (для смайлов 7TV) — из данных канала
    Kick.user(login).then(function (u) {
      if (Chat.channel !== login || !Chat.active) return;
      if (!u.chatroomId) { Chat.state.textContent = tr('чат недоступен'); return; }
      Chat.chatroomId = u.chatroomId;
      loadHistory(u.id, login);
      loadEmotes(u.kickUserId || u.id);
      connect();
    }).catch(function () {
      if (Chat.channel === login) reconnect();
    });
  };

  Chat.stop = function () {
    Chat.active = false;
    Chat.queue = [];
    clearTimeout(Chat.reconnectTimer);
    if (Chat.ws) {
      try { Chat.ws.onclose = null; Chat.ws.close(); } catch (e) { /* уже закрыт */ }
      Chat.ws = null;
    }
  };

  function connect() {
    var ch = Chat.channel, room = Chat.chatroomId;
    var ws;
    if (Chat.ws) { try { Chat.ws.onclose = null; Chat.ws.close(); } catch (e0) { /* ignore */ } }
    try { ws = new WebSocket(PUSHER); } catch (e) { return reconnect(); }
    Chat.ws = ws;
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handle(ws, msg, room);
    };
    ws.onclose = function () { if (Chat.ws === ws && Chat.active && Chat.channel === ch) reconnect(); };
    ws.onerror = function () { /* onclose сработает следом */ };
  }

  function reconnect() {
    if (!Chat.active) return;
    Chat.retry++;
    Chat.state.textContent = tr('переподключение…');
    var ch = Chat.channel;
    clearTimeout(Chat.reconnectTimer);
    Chat.reconnectTimer = setTimeout(function () {
      if (!Chat.active || Chat.channel !== ch) return;
      if (Chat.chatroomId) connect(); else { Chat.active = false; Chat.start(ch); }
    }, Math.min(15000, 1000 * Chat.retry));
  }

  function connected() {
    Chat.state.textContent = '';
    Chat.queue = Chat.queue.filter(function (m) { return m.cls !== 'chat-connecting'; });
    U.$$('.chat-connecting', Chat.list).forEach(function (el) { el.parentNode.removeChild(el); });
  }

  function data(msg) {
    if (typeof msg.data !== 'string') return msg.data || {};
    try { return JSON.parse(msg.data); } catch (e) { return {}; }
  }

  function handle(ws, msg, room) {
    var ev = msg.event || '';
    if (ev === 'pusher:connection_established') {
      Chat.retry = 0;
      ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: 'chatrooms.' + room + '.v2' } }));
      return;
    }
    if (ev === 'pusher:ping') { ws.send(JSON.stringify({ event: 'pusher:pong', data: {} })); return; }
    if (ev === 'pusher_internal:subscription_succeeded') {
      connected();
      Chat.system(tr('Добро пожаловать в чат!'));
      return;
    }
    if (/ChatMessageEvent$/.test(ev)) {
      connected();
      message(data(msg));
    } else if (/ChatroomClearEvent$/.test(ev)) {
      Chat.list.innerHTML = '';
      Chat.system(tr('Чат очищен модератором'));
    } else if (/MessageDeletedEvent$/.test(ev)) {
      var d = data(msg), id = d.message && d.message.id;
      if (id) U.$$('.chat-line', Chat.list).forEach(function (el) { if (el.getAttribute('data-id') === String(id)) el.classList.add('deleted'); });
    } else if (/GiftedSubscriptionsEvent$/.test(ev)) {
      var g = data(msg);
      Chat.system((g.gifter_username || '?') + ' ' + tr('дарит подписки:') + ' ' + ((g.gifted_usernames || []).length || 1), 'notice');
    } else if (/SubscriptionEvent$/.test(ev)) {
      var s = data(msg);
      if (s.username) Chat.system(s.username + ' ' + tr('оформил(а) подписку') + (s.months ? ' • ' + s.months : ''), 'notice');
    }
  }

  function message(m) {
    if (!m || !m.sender) return;
    var nick = m.sender.username || m.sender.slug || '';
    if (App.isBlocked(m.sender.slug || nick)) return; // заблокированные — и в чате не показываем
    var idn = m.sender.identity || {};
    push({ id: m.id, nick: nick, color: idn.color, text: String(m.content || ''), badges: idn.badges || [],
      reply: m.type === 'reply' && m.metadata && m.metadata.original_sender ? m.metadata.original_sender.username : '' });
  }

  // последние сообщения — чтобы чат не был пустым при открытии эфира
  function loadHistory(channelId, login) {
    if (!channelId) return;
    fetch('https://kick.com/api/v2/channels/' + channelId + '/messages', { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) {
        if (Chat.channel !== login || !Chat.active) return;
        var list = (d && d.data && d.data.messages) || [];
        list.slice(0, 30).reverse().forEach(message);
      }).catch(function () {});
  }

  // Сообщения пачкой раз в 400 мс — меньше перерисовок, плеер не тормозит на активных чатах
  function push(msg) {
    Chat.queue.push(msg);
    if (Chat.queue.length > MAX_LINES) Chat.queue.splice(0, Chat.queue.length - MAX_LINES);
    if (!Chat.flushTimer) Chat.flushTimer = setTimeout(flush, 400);
  }

  function flush() {
    Chat.flushTimer = null;
    if (!Chat.active || Chat.el.classList.contains('hidden')) { Chat.queue = []; return; }
    var frag = document.createDocumentFragment();
    Chat.queue.forEach(function (m) { frag.appendChild(render(m)); });
    Chat.queue = [];
    Chat.list.appendChild(frag);
    var extra = Chat.list.children.length - MAX_LINES;
    while (extra-- > 0) Chat.list.removeChild(Chat.list.firstChild);
  }

  // Системные строки идут через ту же очередь, чтобы не обгонять сообщения
  Chat.system = function (text, cls) {
    if (!Chat.active) return;
    push({ system: text, cls: cls });
  };

  // Тёмные ники поверх видео не читаются — светлота в HSL не ниже 68%
  function lighten(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    var n = parseInt(m[1], 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, hh = 0, ss = 0, d = max - min;
    if (l >= 0.68) return hex;
    if (d) {
      ss = d / (1 - Math.abs(2 * l - 1));
      hh = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      hh = Math.round(hh * 60); if (hh < 0) hh += 360;
    }
    return 'hsl(' + hh + ',' + Math.round(Math.min(1, ss) * 100) + '%,68%)';
  }

  function color(nick, c) {
    if (c) return lighten(c);
    var s = 0;
    for (var i = 0; i < nick.length; i++) s += nick.charCodeAt(i);
    return DEFAULT_COLORS[s % DEFAULT_COLORS.length];
  }

  function emoteImg(url, name) {
    return '<img class="emote" src="' + U.esc(url) + '" alt="' + U.esc(name) + '">';
  }

  // Значки Kick — цветными метками (как на kick.com)
  var BADGES = {
    broadcaster: ['host', '●'], moderator: ['mod', '⚔'], vip: ['vip', '◆'], og: ['og', 'OG'], founder: ['founder', '★'],
    verified: ['verified', '✓'], subscriber: ['sub', '★'], sub_gifter: ['gift', '♥'], staff: ['staff', 'K']
  };

  function render(m) {
    if (m.system) return h('div.chat-line.chat-system' + (m.cls ? '.' + m.cls : ''), { text: m.system });
    // смайлы Kick в тексте: [emote:37226:KEKW]
    var html = '', re = /\[emote:(\d+):([^\]]*)\]/g, pos = 0, x;
    while ((x = re.exec(m.text))) {
      html += words(m.text.slice(pos, x.index));
      html += emoteImg('https://files.kick.com/emotes/' + x[1] + '/fullsize', x[2]);
      pos = x.index + x[0].length;
    }
    html += words(m.text.slice(pos));

    var badges = '';
    (m.badges || []).slice(0, 3).forEach(function (b) {
      var f = BADGES[b.type];
      if (f) badges += '<span class="cb cb-' + f[0] + '">' + f[1] + '</span>';
    });
    var c = color(m.nick, m.color);
    var line = document.createElement('div');
    line.className = 'chat-line';
    if (m.id) line.setAttribute('data-id', m.id);
    line.innerHTML = badges + '<span class="chat-nick" style="color:' + U.esc(c) + '">' + U.esc(m.nick) + '</span>' +
      '<span class="chat-colon">: </span>' +
      (m.reply ? '<span class="chat-reply">@' + U.esc(m.reply) + ' </span>' : '') +
      '<span class="chat-text">' + html + '</span>';
    return line;
  }

  // Текст: экранируем и подставляем смайлы 7TV по словам
  function words(s) {
    if (!s) return '';
    return s.split(' ').map(function (w) {
      var e = Chat.emotes[w] || globalEmotes[w];
      return e ? emoteImg(e, w) : U.esc(w);
    }).join(' ');
  }

  function getJSON(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }

  // 7TV — расширение со смайлами, которым пользуются зрители Kick
  var globalEmotes = {}, globalLoaded = false;
  function loadEmotes(userId) {
    if (!globalLoaded) {
      globalLoaded = true;
      getJSON('https://7tv.io/v3/emote-sets/global').then(function (s) {
        (s.emotes || []).forEach(function (e) { globalEmotes[e.name] = 'https://cdn.7tv.app/emote/' + e.id + '/1x.webp'; });
      }).catch(function () { globalLoaded = false; });
    }
    if (!userId) return;
    var login = Chat.channel;
    getJSON('https://7tv.io/v3/users/kick/' + userId).then(function (d) {
      if (Chat.channel !== login) return;
      var set = d.emote_set && d.emote_set.emotes;
      (set || []).forEach(function (e) { if (!Chat.emotes[e.name]) Chat.emotes[e.name] = 'https://cdn.7tv.app/emote/' + e.id + '/1x.webp'; });
    }).catch(function () {});
  }

  window.Chat = Chat;
})();
