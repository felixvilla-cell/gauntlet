/* Daily Gauntlet service worker -- home-screen badge + push, plus ONE fetch
   rule: page loads (navigations) bypass the HTTP cache. GitHub Pages sends
   max-age=600, so without this a phone could keep running a stale copy for
   10 minutes after an update (bit Felix 2026-09-24: bonus run showed 0 of 3).
   Nothing is ever stored; offline falls back to the normal cached fetch. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.mode !== "navigate" && !/\/(config\.js)(\?|$)/.test(new URL(r.url).pathname + new URL(r.url).search)) return;
  e.respondWith(fetch(r, { cache: "no-store" }).catch(() => fetch(r)));
});

// payload: {"title": str, "body": str, "badge": int, "tag": str, "url": str}
self.addEventListener("push", event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
  const n = Math.max(0, parseInt(d.badge, 10) || 0);
  const nav = self.navigator;
  const setBadge = (async () => {
    try {
      if (n > 0 && nav && "setAppBadge" in nav) await nav.setAppBadge(n);
      else if (n === 0 && nav && "clearAppBadge" in nav) await nav.clearAppBadge();
    } catch (e) {}
  })();
  // ALWAYS show a notification: iOS revokes push permission when a push
  // arrives and nothing is shown.
  const note = self.registration.showNotification(d.title || "DAILY GAUNTLET", {
    body: d.body || "",
    tag: d.tag || "gauntlet",
    icon: "icon-180.png",
    data: { url: d.url || "./" },
  });
  event.waitUntil(Promise.all([setBadge, note]));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of wins) { if ("focus" in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
