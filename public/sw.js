/* Pawsie service worker: shows dose alerts pushed from the server. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { title: "Pawsie", body: event.data ? event.data.text() : "" }; }
  const opts = {
    body: d.body || "",
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    requireInteraction: !!d.urgent,
    data: { url: d.url || "/", h: d.h, doseId: d.doseId, tel: d.tel },
    actions: d.doseId ? [{ action: "given", title: "Mark given" }] : [],
  };
  event.waitUntil(self.registration.showNotification(d.title || "Pawsie", opts));
});

self.addEventListener("notificationclick", (event) => {
  const n = event.notification, data = n.data || {};
  n.close();
  if (event.action === "given" && data.h && data.doseId) {
    event.waitUntil(
      fetch("/api/op", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ h: data.h, op: { t: "given", id: data.doseId, ts: Date.now() } }),
      }).catch(() => {}),
    );
    return;
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow(data.url || "/");
    }),
  );
});
