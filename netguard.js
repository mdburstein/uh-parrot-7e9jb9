// UH Parrot network guard. Loaded first in the page and imported first in the worker.
// Any request that is not to this site's own origin is refused before it is sent, and logged.
// This is belt-and-suspenders on top of the Content-Security-Policy in index.html.
(function (g) {
  'use strict';
  const origin = g.location.origin;
  const allowed = (url) => {
    try {
      const u = new URL(String(url), g.location.href);
      return u.origin === origin || u.protocol === 'blob:' || u.protocol === 'data:';
    } catch (e) { return false; }
  };
  const refuse = (what, url) => {
    const msg = 'UH Parrot blocked an outbound ' + what + ' to ' + url + ' (only same-origin requests are permitted)';
    try { console.error(msg); } catch (e) { }
    throw new Error(msg);
  };
  if (g.fetch) {
    const realFetch = g.fetch.bind(g);
    g.fetch = function (input, init) {
      const url = (input && input.url) ? input.url : input;
      if (!allowed(url)) return Promise.reject(refuseErr('fetch', url));
      return realFetch(input, init);
    };
  }
  function refuseErr(what, url) { try { refuse(what, url); } catch (e) { return e; } }
  if (g.XMLHttpRequest) {
    const open = g.XMLHttpRequest.prototype.open;
    g.XMLHttpRequest.prototype.open = function (method, url) {
      if (!allowed(url)) refuse('XMLHttpRequest', url);
      return open.apply(this, arguments);
    };
  }
  if (g.WebSocket) {
    g.WebSocket = new Proxy(g.WebSocket, { construct(t, args) { refuse('WebSocket', args[0]); } });
  }
  if (g.EventSource) {
    g.EventSource = new Proxy(g.EventSource, { construct(t, args) { refuse('EventSource', args[0]); } });
  }
  if (g.navigator && g.navigator.sendBeacon) {
    g.navigator.sendBeacon = function (url) { refuse('sendBeacon', url); };
  }
  if (g.importScripts) {
    const real = g.importScripts;
    g.importScripts = function () { for (const u of arguments) if (!allowed(u)) refuse('importScripts', u); return real.apply(g, arguments); };
  }
  g.__UH_PARROT_NETGUARD__ = { origin };
})(typeof self !== 'undefined' ? self : window);
