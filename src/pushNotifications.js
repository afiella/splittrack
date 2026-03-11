import { getToken, isSupported } from "firebase/messaging";
import { saveDeviceToken } from "./data";

// Get this from Firebase Console → Project Settings → Cloud Messaging → Web Push certificates → Key pair
const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

/**
 * Call once after the user is identified.
 * Requests notification permission, gets the FCM web push token,
 * and saves it to Firestore so Cloud Functions can reach this device.
 *
 * Only works on iOS 16.4+ when the app is added to the Home Screen.
 * Silently does nothing on unsupported browsers or if permission is denied.
 *
 * @param {string} userId  "cam" | "ella"
 */
export async function initPushNotifications(userId) {
  try {
    // Check browser support
    const supported = await isSupported();
    if (!supported) return;

    // Need a VAPID key to proceed
    if (!VAPID_KEY) {
      console.warn("VITE_FIREBASE_VAPID_KEY not set — push notifications disabled");
      return;
    }

    // Request permission
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;

    // Dynamically get the messaging instance (it may still be initializing)
    const { messaging } = await import("./firebase");
    if (!messaging) return;

    // Register the service worker first (required for background push)
    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js", {
      scope: "/",
    });

    // Get the FCM token
    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    });

    if (token) {
      await saveDeviceToken(userId, token);
    }
  } catch (err) {
    // Non-fatal — push notifications are best-effort
    console.warn("Push notification init failed:", err.message);
  }
}
