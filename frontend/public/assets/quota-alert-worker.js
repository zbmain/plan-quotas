/** Bring the public dashboard into view when the user opens its notification. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const pages = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const dashboard = pages.find(
        (page) => new URL(page.url).pathname === "/",
      );
      if (dashboard) await dashboard.focus();
      else await self.clients.openWindow("/");
    })(),
  );
});
