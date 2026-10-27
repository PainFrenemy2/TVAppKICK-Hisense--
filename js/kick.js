/* Работа с Kick: открытые API сайта kick.com (каналы, эфиры, категории, записи, клипы, поиск).
   Ответы приводим к одному виду, с которым работает интерфейс:
   эфир   { id, title, viewersCount, createdAt, previewImageURL, broadcaster{id login displayName profileImageURL}, game{id name displayName} }
   канал  { id, login, displayName, description, profileImageURL, bannerImageURL, followers{totalCount}, stream, chatroomId }
   категория { id, name (slug), displayName, viewersCount, boxArtURL }
   У Kick нет официального списка всех адресов для сторонних приложений, поэтому для каждого действия
   пробуем несколько известных адресов; какой сработал — запоминаем, итог каждого — в Kick.diag (для «Диагностики»). */
(function () {
  'use strict';

  var K = {};
  var SITE = 'https://kick.com';

  // ---------- сеть ----------
  var cache = {}, inflight = {};
  var CACHE_MS = 60 * 1000;
  K.diag = {}; // имя действия → { url, ok, info, ms }

  function request(url, timeout, retries) {
    return new Promise(function (resolve, reject) {
      var attempt = 0;
      function go() {
        var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          if (ctrl) ctrl.abort();
          fail(new Error(tr('Таймаут сети')));
        }, timeout || 12000);
        var init = { headers: { 'Accept': 'application/json' } };
        if (ctrl) init.signal = ctrl.signal;
        fetch(url, init).then(function (r) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (r.status >= 500 || r.status === 429) return fail(new Error('HTTP ' + r.status));
          if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; return reject(e); }
          r.json().then(resolve, function () { reject(new Error(tr('Kick ответил не JSON'))); });
        }, function (e) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          fail(e);
        });
      }
      function fail(e) {
        if (attempt++ < (retries === undefined ? 1 : retries)) setTimeout(go, 700 * attempt);
        else reject(e);
      }
      go();
    });
  }

  function getJSON(url, opts) {
    opts = opts || {};
    var useCache = opts.cache !== false;
    var c = cache[url];
    if (useCache && c && Date.now() - c.t < (opts.ttl || CACHE_MS)) return Promise.resolve(c.d);
    if (inflight[url]) return inflight[url];
    var p = request(url, opts.timeout, opts.retries).then(function (d) {
      if (useCache) {
        cache[url] = { t: Date.now(), d: d };
        var keys = Object.keys(cache);
        while (keys.length > 120) delete cache[keys.shift()];
      }
      return d;
    });
    inflight[url] = p;
    var clear = function () { if (inflight[url] === p) delete inflight[url]; };
    p.then(clear, clear);
    return p;
  }

  // Несколько адресов для одного действия: по очереди, пока какой-то не даст непустой результат.
  // Сработавший запоминаем и в следующий раз пробуем первым.
  function tryUrls(name, urls, parse) {
    var good = U.store.get('kickApi', {})[name];
    var order = urls.slice().sort(function (a, b) { return (b.id === good) - (a.id === good); });
    var i = 0, errs = [];
    function next() {
      if (i >= order.length) {
        K.diag[name] = { ok: false, info: errs.join(' | ') || 'empty', ms: 0 };
        var e = new Error(errs[errs.length - 1] || tr('Kick не отдал данные'));
        return Promise.reject(e);
      }
      var u = order[i++], t0 = Date.now();
      return getJSON(u.url, u.opts).then(function (d) {
        var out = parse(d, u.id);
        if (!out || (out.items ? !out.items.length && !u.allowEmpty : (Array.isArray(out) && !out.length && !u.allowEmpty))) {
          errs.push(u.id + ': empty');
          return next();
        }
        K.diag[name] = { ok: true, info: u.id, ms: Date.now() - t0 };
        if (good !== u.id) { var m = U.store.get('kickApi', {}); m[name] = u.id; U.store.set('kickApi', m); }
        return out;
      }, function (e) {
        errs.push(u.id + ': ' + ((e && e.message) || e));
        return next();
      });
    }
    return next();
  }

  function qs(o) {
    var a = [];
    for (var k in o) if (o[k] !== undefined && o[k] !== null && o[k] !== '') a.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k]));
    return a.join('&');
  }

  // ---------- приведение ответов Kick к общему виду ----------
  // Kick отдаёт время то как «2024-05-01 18:00:00» (UTC без зоны), то как ISO
  function iso(t) {
    if (!t) return null;
    if (typeof t === 'number') return new Date(t).toISOString();
    var s = String(t);
    if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    return s;
  }
  function pic(o) {
    if (!o) return '';
    if (typeof o === 'string') return o;
    return o.src || o.url || o.responsive || '';
  }
  function num(x) { x = +x; return isFinite(x) ? x : 0; }

  function userOf(ch) {
    ch = ch || {};
    var u = ch.user || {};
    return {
      id: ch.id || ch.channel_id || ch.broadcaster_user_id || u.id,
      login: String(ch.slug || u.slug || u.username || '').toLowerCase(),
      displayName: u.username || ch.username || ch.slug || '',
      profileImageURL: u.profile_pic || u.profilepic || u.profilePic || u.profile_picture || ch.profile_picture || ch.profile_pic || ''
    };
  }
  function gameOf(c) {
    if (!c) return null;
    return { id: c.id, name: c.slug || c.name, displayName: c.name || c.slug, viewersCount: num(c.viewers || c.viewer_count),
      boxArtURL: pic(c.banner) || pic(c.thumbnail) || '' };
  }
  // эфир: ls — объект livestream, ch — канал (если эфир пришёл внутри канала)
  function streamOf(ls, ch) {
    if (!ls) return null;
    var cats = ls.categories || (ls.category ? [ls.category] : []);
    var b = userOf(ch || ls.channel || ls);
    return {
      id: ls.id,
      title: ls.session_title || ls.stream_title || ls.title || '',
      viewersCount: num(ls.viewer_count !== undefined ? ls.viewer_count : ls.viewers),
      createdAt: iso(ls.created_at || ls.start_time || ls.started_at),
      previewImageURL: pic(ls.thumbnail) || '',
      language: ls.language || '',
      mature: !!(ls.is_mature || ls.has_mature_content),
      broadcaster: b,
      game: gameOf(cats[0])
    };
  }
  function channelOf(ch) {
    var u = userOf(ch);
    var user = ch.user || {};
    u.description = user.bio || ch.bio || '';
    u.bannerImageURL = pic(ch.banner_image) || pic(ch.offline_banner_image) || '';
    u.followers = { totalCount: num(ch.followers_count !== undefined ? ch.followers_count : ch.followersCount) };
    u.stream = ch.livestream ? streamOf(ch.livestream, ch) : null;
    u.chatroomId = ch.chatroom && ch.chatroom.id;
    u.kickUserId = ch.user_id || user.id;
    u.playbackUrl = ch.playback_url || '';
    u.verified = !!ch.verified;
    u.recentGames = (ch.recent_categories || []).map(gameOf).filter(Boolean);
    return u;
  }
  function videoOf(v, ch) {
    var src = v.source || (v.video && v.video.source) || '';
    var id = (v.video && v.video.uuid) || v.uuid || v.id;
    if (src) vodSources[id] = src;
    var cats = v.categories || (v.category ? [v.category] : []);
    return {
      id: id,
      title: v.session_title || v.title || (v.video && v.video.title) || '',
      lengthSeconds: Math.round(num(v.duration) / (num(v.duration) > 100000 ? 1000 : 1)),
      viewCount: num(v.views || (v.video && v.video.views)),
      createdAt: iso(v.start_time || v.created_at),
      broadcastType: 'ARCHIVE',
      previewThumbnailURL: pic(v.thumbnail),
      owner: userOf(ch || v.channel || v),
      game: gameOf(cats[0])
    };
  }
  function clipOf(c) {
    if (c.clip_url || c.video_url) clipUrls[c.id] = c.clip_url || c.video_url;
    var ch = c.channel || {};
    return {
      id: c.id,
      slug: c.id,
      title: c.title || '',
      viewCount: num(c.view_count !== undefined ? c.view_count : (c.views !== undefined ? c.views : c.likes_count)),
      durationSeconds: num(c.duration),
      createdAt: iso(c.created_at),
      thumbnailURL: c.thumbnail_url || pic(c.thumbnail),
      broadcaster: { id: ch.id, login: String(ch.slug || ch.username || '').toLowerCase(), displayName: ch.username || ch.slug || '', profileImageURL: ch.profile_picture || ch.profile_pic || '' },
      game: gameOf(c.category)
    };
  }
  var vodSources = {}, clipUrls = {};

  function listOf(d) {
    if (!d) return [];
    if (Array.isArray(d)) return d;
    if (Array.isArray(d.data)) return d.data;
    if (d.data && Array.isArray(d.data.livestreams)) return d.data.livestreams;
    if (Array.isArray(d.livestreams)) return d.livestreams;
    if (d.data && Array.isArray(d.data.data)) return d.data.data;
    if (Array.isArray(d.clips)) return d.clips;
    if (d.data && Array.isArray(d.data.clips)) return d.data.clips;
    return [];
  }
  function pageOf(d, list, pageNo) {
    var more = !!(d && (d.next_page_url || d.next_cursor || d.nextCursor || (d.data && d.data.next_cursor) || (d.pagination && d.pagination.next_cursor)));
    if (!more && d && d.last_page && d.current_page) more = d.current_page < d.last_page;
    return { items: list, cursor: more ? String((pageNo || 1) + 1) : null, more: more };
  }

  // ---------- каналы ----------
  K.user = function (login) {
    login = String(login || '').toLowerCase();
    return tryUrls('channel', [
      { id: 'v2', url: SITE + '/api/v2/channels/' + encodeURIComponent(login), opts: { ttl: 20000 } },
      { id: 'v1', url: SITE + '/api/v1/channels/' + encodeURIComponent(login), opts: { ttl: 20000 } }
    ], function (d) { return d && (d.slug || d.user) ? channelOf(d) : null; });
  };
  // Kick не умеет отдавать несколько каналов за раз — по 4 параллельно
  K.users = function (logins) {
    var list = (logins || []).slice(0, 60);
    return U.pool(list, 4, function (l) { return K.user(l).catch(function () { return null; }); })
      .then(function (r) { return r.filter(Boolean); });
  };

  // ---------- эфиры ----------
  // Популярные эфиры: lang — язык ('ru', 'en'…) или пусто (все языки); category — slug категории
  function livestreams(name, lang, category, pageNo, limit) {
    pageNo = pageNo || 1;
    limit = limit || 24;
    var l = lang || 'all';
    var urls = [
      { id: 'stream/livestreams', url: SITE + '/stream/livestreams/' + l + '?' + qs({ page: pageNo, limit: limit, subcategory: category, sort: 'desc' }) },
      { id: 'web/v1/livestreams', url: 'https://web.kick.com/api/v1/livestreams?' + qs({ limit: limit, sort: 'viewer_count_desc', page: pageNo, category: category, language: lang }) },
      { id: 'api/v1/livestreams', url: SITE + '/api/v1/livestreams?' + qs({ page: pageNo, limit: limit, subcategory: category, language: lang, sort: 'desc' }) }
    ];
    if (category) urls.push({ id: 'v2/categories/livestreams', url: SITE + '/api/v2/categories/' + encodeURIComponent(category) + '/livestreams?' + qs({ page: pageNo, limit: limit }) });
    return tryUrls(name, urls, function (d) {
      var list = listOf(d).map(function (x) { return streamOf(x.livestream || x, x.channel); }).filter(function (s) { return s && s.broadcaster.login; });
      return pageOf(d, list, pageNo);
    });
  }
  K.topStreams = function (first, after) { return livestreams('top streams', '', null, after ? +after : 1, first); };
  K.topStreamsByLang = function (lang, first, after) { return livestreams('streams by language', String(lang || '').split('-')[0], null, after ? +after : 1, first); };
  K.gameStreams = function (slug, first, after) {
    return livestreams('category streams', '', slug, after ? +after : 1, first).then(function (p) {
      p.game = { name: slug, displayName: slug };
      return p;
    });
  };
  K.gameStreamsLangs = function (slug, first, langs) {
    return livestreams('category streams', (langs && langs[0]) || '', slug, 1, first).then(function (p) { return p.items; })
      .catch(function () { return K.gameStreams(slug, first).then(function (p) { return p.items; }); });
  };

  // ---------- категории ----------
  K.topGames = function (first, after) {
    var pageNo = after ? +after : 1;
    return tryUrls('categories', [
      { id: 'v1/subcategories', url: SITE + '/api/v1/subcategories?' + qs({ limit: first || 32, page: pageNo }) },
      { id: 'v1/categories/top', url: SITE + '/api/v1/categories/top' },
      { id: 'web/v1/categories', url: 'https://web.kick.com/api/v1/categories?' + qs({ limit: first || 32, page: pageNo }) }
    ], function (d) {
      var list = listOf(d).map(gameOf).filter(function (g) { return g && g.name; });
      list.sort(function (a, b) { return b.viewersCount - a.viewersCount; });
      return pageOf(d, list, pageNo);
    });
  };

  // ---------- записи и клипы ----------
  K.videos = function (login, type, first) {
    login = String(login || '').toLowerCase();
    if (type && type !== 'ARCHIVE') return Promise.resolve({ items: [], cursor: null, more: false });
    return tryUrls('videos', [
      { id: 'v2/videos', url: SITE + '/api/v2/channels/' + encodeURIComponent(login) + '/videos', allowEmpty: true },
      { id: 'v1/videos', url: SITE + '/api/v1/channels/' + encodeURIComponent(login) + '/videos', allowEmpty: true }
    ], function (d) {
      return { items: listOf(d).slice(0, first || 30).map(function (v) { return videoOf(v); }), cursor: null, more: false };
    });
  };
  K.gameVideos = function () { return Promise.resolve([]); };

  var PERIOD = { LAST_DAY: 'day', LAST_WEEK: 'week', LAST_MONTH: 'month', ALL_TIME: 'all' };
  function clipsFrom(name, base, period, first) {
    var p = { sort: 'view', time: PERIOD[period] || period || 'week' };
    return tryUrls(name, [
      { id: 'v2', url: base + '?' + qs(p), allowEmpty: true }
    ], function (d) { return listOf(d).slice(0, first || 30).map(clipOf); });
  }
  K.clips = function (login, period, first) {
    return clipsFrom('channel clips', SITE + '/api/v2/channels/' + encodeURIComponent(String(login).toLowerCase()) + '/clips', period, first);
  };
  K.gameClips = function (slug, first, period) {
    return clipsFrom('category clips', SITE + '/api/v2/categories/' + encodeURIComponent(slug) + '/clips', period, first);
  };
  K.topClips = function (first, period) {
    return clipsFrom('top clips', SITE + '/api/v2/clips', period || 'LAST_DAY', first);
  };

  // ---------- поиск ----------
  K.search = function (text) {
    var exact = K.user(text.replace(/\s+/g, '').toLowerCase()).catch(function () { return null; });
    var main = getJSON(SITE + '/api/search?' + qs({ searched_word: text }), { retries: 0 }).then(function (d) {
      return {
        channels: (d.channels || []).map(function (c) {
          var u = userOf(c);
          u.followers = { totalCount: num(c.followersCount || c.followers_count) };
          u.isLive = !!(c.isLive || c.is_live);
          return u;
        }),
        games: (d.categories || []).map(gameOf).filter(Boolean)
      };
    }).catch(function () { return { channels: [], games: [] }; });
    return Promise.all([exact, main]).then(function (r) {
      var res = r[1];
      if (r[0]) {
        res.channels = res.channels.filter(function (c) { return c.login !== r[0].login; });
        res.channels.unshift(r[0]);
      }
      // кто из найденных в эфире — подробности эфира берём из канала (не больше 6 запросов)
      var liveLogins = res.channels.filter(function (c) { return c.stream || c.isLive; }).slice(0, 6).map(function (c) { return c.login; });
      return K.users(liveLogins).then(function (us) {
        var byLogin = {};
        us.forEach(function (u) { byLogin[u.login] = u; });
        res.channels = res.channels.map(function (c) { return byLogin[c.login] || c; });
        res.live = res.channels.filter(function (c) { return c.stream; }).map(function (c) { return c.stream; });
        return res;
      });
    });
  };

  // ---------- воспроизведение ----------
  // Адрес HLS эфира Kick отдаёт вместе с каналом (playback_url)
  K.liveUrl = function (login) {
    login = String(login || '').toLowerCase();
    var fresh = function () { delete cache[SITE + '/api/v2/channels/' + login]; delete cache[SITE + '/api/v1/channels/' + login]; };
    fresh();
    return K.user(login).then(function (u) {
      if (u.playbackUrl) return u.playbackUrl;
      return getJSON(SITE + '/api/v2/channels/' + encodeURIComponent(login) + '/livestream', { cache: false }).then(function (d) {
        var url = d && d.data && (d.data.playback_url || d.data.playbackUrl);
        if (!url) throw new Error(tr('Канал сейчас не в эфире'));
        return url;
      });
    });
  };
  K.vodUrl = function (id) {
    if (vodSources[id]) return Promise.resolve(vodSources[id]);
    return tryUrls('video', [
      { id: 'v1/video', url: SITE + '/api/v1/video/' + encodeURIComponent(id) },
      { id: 'v2/video', url: SITE + '/api/v2/video/' + encodeURIComponent(id) }
    ], function (d) { return d && (d.source || (d.data && d.data.source)) ? [d.source || d.data.source] : null; })
      .then(function (r) { return r[0]; });
  };
  K.clipSources = function (id) {
    var make = function (url) { return [{ quality: 0, fps: 30, url: url }]; };
    if (clipUrls[id]) return Promise.resolve(make(clipUrls[id]));
    return tryUrls('clip', [
      { id: 'v2/clips', url: SITE + '/api/v2/clips/' + encodeURIComponent(id) }
    ], function (d) {
      var c = (d && d.clip) || d;
      var url = c && (c.clip_url || c.video_url);
      return url ? [url] : null;
    }).then(function (r) { return make(r[0]); });
  };

  // ---------- для главной ----------
  // Категории по вашим каналам: во что они играют сейчас или играли недавно (чаще — выше)
  K.tasteGames = function (logins) {
    var c = U.store.get('tasteGames', null);
    if (c && c.n === logins.length && Date.now() - c.at < 6 * 3600e3) return Promise.resolve(c.games);
    return K.users(logins.slice(0, 30)).then(function (us) {
      var cnt = {}, byName = {};
      us.forEach(function (u) {
        var gs = (u.stream && u.stream.game ? [u.stream.game] : []).concat(u.recentGames || []);
        gs.slice(0, 2).forEach(function (g) {
          if (!g || !g.name) return;
          cnt[g.name] = (cnt[g.name] || 0) + 1;
          byName[g.name] = g;
        });
      });
      var games = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; }).slice(0, 8).map(function (n) { return byName[n]; });
      U.store.set('tasteGames', { n: logins.length, at: Date.now(), games: games });
      return games;
    });
  };
  // персональных рядов у Kick для сторонних приложений нет
  K.personalShelves = function () { return Promise.resolve([]); };
  K.liveRecs = function () { return Promise.resolve([]); };
  K.recsDiag = [];

  // кодеки: Kick отдаёт H.264 — отдельная настройка не нужна
  K.codecSupport = function () {
    var ms = window.MediaSource || window.WebKitMediaSource;
    var ok = function (c) { try { return !!(ms && ms.isTypeSupported('video/mp4; codecs="' + c + '"')); } catch (e) { return false; } };
    return { h264: ok('avc1.64002A'), hevc: ok('hvc1.1.6.L150.90') || ok('hev1.1.6.L150.90'), av1: ok('av01.0.08M.08') };
  };
  K.codecs = function () { return 'avc1'; };

  K.clearCache = function () { cache = {}; };

  window.Kick = K;
})();
