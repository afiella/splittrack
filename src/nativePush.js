import { PushNotifications } from "@capacitor/push-notifications";
import { saveNativeToken } from "./data";

export async function initNativePush(userId, onNavigate) {
  try {
    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== "granted") {
      console.warn("Native push: permission denied");
      return;
    }

    // Add listeners BEFORE register() so the token isn't missed
    await PushNotifications.addListener("registration", async (token) => {
      console.log("Native push: APNs token =", token.value.slice(0, 16) + "…");
      await saveNativeToken(userId, token.value);
    });

    await PushNotifications.addListener("registrationError", (err) => {
      console.error("Native push: registration error", JSON.stringify(err));
    });

    await PushNotifications.register();

    // Notification tapped while app is open
    await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      const screen = action.notification?.data?.screen;
      if (screen && onNavigate) onNavigate(screen);
    });

  } catch (err) {
    console.warn("Native push: init failed —", err.message);
  }
}
