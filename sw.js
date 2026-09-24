/* Daily Gauntlet service worker -- home-screen badge + push ONLY.
   There is deliberately NO fetch handler: nothing is cached or intercepted,
   so the game always loads fresh from the network. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

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
