// firebase-messaging-sw.js
// This service worker handles background push notifications for the SplitTrack PWA.
// It must live at the root of the site so it can intercept all push events.

importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

// Keep this in sync with src/firebase.js — service workers can't use ES modules or Vite env vars
firebase.initializeApp({
  apiKey:            "AIzaSyBv65oob-_p_jWu7yXeXatbLUwYMrBOP5E",
  authDomain:        "splittrack-b2fc4.firebaseapp.com",
  projectId:         "splittrack-b2fc4",
  storageBucket:     "splittrack-b2fc4.firebasestorage.app",
  messagingSenderId: "527843835218",
  appId:             "1:527843835218:web:9dab5acf5d53a61d9ace8b",
});

const messaging = firebase.messaging();

// Background push handler — shows the notification when the app is closed or in background
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  if (!title) return;

  self.registration.showNotification(title, {
    body: body || "",
    icon: "/icons/icon-192.png",   // add a 192x192 app icon here if you have one
    badge: "/icons/badge-72.png",  // optional monochrome badge icon
    data: payload.data || {},
    vibrate: [200, 100, 200],
  });
});

// Notification tap — opens the app and posts the target screen to navigate to
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
      // App is closed — open it; App.jsx will read the message on load
      return clients.openWindow(url + "?screen=" + screen);
    })
  );
});
