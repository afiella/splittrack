import { getMessaging, getToken, isSupported } from "firebase/messaging";
import { app } from "./firebase";
import { saveWebToken } from "./data";

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

export async function initPushNotifications(userId) {
  try {
    if (!("Notification" in window)) {
      console.warn("Push: Notification API not available");
      return;
    }

    if (!VAPID_KEY) {
      console.warn("Push: VITE_FIREBASE_VAPID_KEY is not set");
      return;
    }

    const supported = await isSupported();
    if (!supported) {
      console.warn("Push: firebase/messaging not supported (open as Home Screen app on iOS 16.4+)");
      return;
    }

    const permission = await Notification.requestPermission();
    console.log("Push: permission =", permission);
    if (permission !== "granted") return;

    if (!("serviceWorker" in navigator)) {
      console.warn("Push: service workers not supported");
      return;
    }

    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js", {
      scope: "/",
    });
    console.log("Push: service worker registered", registration.scope);

    const messaging = getMessaging(app);
    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    });

    if (token) {
      await saveWebToken(userId, token);
      localStorage.setItem("fcmTokenSaved", userId);
      console.log("Push: web token saved for", userId);
    } else {
      console.warn("Push: getToken returned empty — check VAPID key and service worker");
    }
  } catch (err) {
    console.warn("Push: init failed —", err.message);
  }
}
