import { PushNotifications } from "@capacitor/push-notifications";
import { saveDeviceToken } from "./data";

export async function initNativePush(userId, onNavigate) {
  try {
    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== "granted") {
      console.warn("Native push: permission denied");
      return;
    }

    await PushNotifications.register();

    // FCM token ready — save to Firestore so Cloud Functions can send to this device
    await PushNotifications.addListener("registration", async (token) => {
      console.log("Native push: token =", token.value);
      await saveDeviceToken(userId, token.value);
    });

    await PushNotifications.addListener("registrationError", (err) => {
      console.error("Native push: registration error", JSON.stringify(err));
    });

    // Notification tapped while app is in foreground
    await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      const screen = action.notification?.data?.screen;
      if (screen && onNavigate) onNavigate(screen);
    });

  } catch (err) {
    console.warn("Native push: init failed —", err.message);
  }
}
