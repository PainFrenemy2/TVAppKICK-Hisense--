/* Вход в Kick. Kick пускает сторонние приложения только через вход в браузере с возвратом на сайт приложения
   (OAuth с redirect) — на телевизоре так войти нельзя, а входа по коду, как у Twitch, у Kick нет.
   Поэтому приложение работает без входа: отслеживаемые каналы хранятся на телевизоре («Избранное»).
   Объект Auth оставлен с тем же набором функций, что ждёт интерфейс, — все они отвечают «не вошли». */
(function () {
  'use strict';
  var Auth = {
    data: null,
    accounts: [],
    listeners: [],
    loggedIn: function () { return false; },
    needsLogin: function () { return false; },
    user: function () { return null; },
    onChange: function (fn) { Auth.listeners.push(fn); },
    ensure: function () { return Promise.reject(new Error(tr('Не выполнен вход'))); },
    cachedFollows: function () { return []; },
    syncFollows: function () { return Promise.resolve([]); },
    followedGames: function () { return Promise.resolve([]); },
    followedLive: function () { return Promise.resolve([]); },
    followedLiveSafe: function () { return Promise.resolve([]); },
    asleep: function () { return document.hidden; }
  };
  window.Auth = Auth;

  // Прогнозы и голосования Kick требуют входа — в этом приложении их нет
  window.Events = {
    start: function () {}, stop: function () {}, onKey: function () { return false; },
    renderCorner: function () {}, openPrediction: function () {}, openPoll: function () {}
  };
})();
