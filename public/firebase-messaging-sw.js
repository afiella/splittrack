// firebase-messaging-sw.js
// Handles background push notifications for the SplitTrack PWA.

importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey:            "AIzaSyBv65oob-_p_jWu7yXeXatbLUwYMrBOP5E",
  authDomain:        "splittrack-b2fc4.firebaseapp.com",
  projectId:         "splittrack-b2fc4",
  storageBucket:     "splittrack-b2fc4.firebasestorage.app",
  messagingSenderId: "527843835218",
  appId:             "1:527843835218:web:9dab5acf5d53a61d9ace8b",
});

const messaging = firebase.messaging();

// Background push handler.
// Cloud functions now send data-only messages to web tokens (no "notification" field),
// so FCM does NOT auto-display — this handler is the single place that shows a notification.
messaging.onBackgroundMessage((payload) => {
  // Title/body come from data field (data-only message format)
  const title = payload.data?.title || payload.notification?.title;
  const body  = payload.data?.body  || payload.notification?.body;
  if (!title) return;

  self.registration.showNotification(title, {
    body: body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    data: payload.data || {},
    vibrate: [200, 100, 200],
  });
});

// Notification tap — focus app and navigate to the target screen
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const screen = event.notification.data?.screen || "dashboard";
  const url = self.registration.scope;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.startsWith(url) && "focus" in client) {
          client.focus();
          client.postMessage({ type: "NAVIGATE", screen });
          return;
        }
      }
      return clients.openWindow(url + "?screen=" + screen);
    })
  );
});
