const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

const db = getFirestore();

// ── Helpers ─────────────────────────────────────────────────────────────

async function getToken(userId) {
  const snap = await db.collection("deviceTokens").doc(userId).get();
  return snap.exists ? snap.data()?.fcmToken : null;
}

async function sendPush(userId, title, body, data = {}) {
  const token = await getToken(userId);
  if (!token) {
    console.warn(`sendPush: no FCM token for user "${userId}" — they need to open the app and accept notifications`);
    return;
  }
  console.log(`sendPush: sending "${title}" to ${userId}`);
  try {
    await getMessaging().send({
      token,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      apns: {
        payload: {
          aps: { sound: "default", badge: 1 },
        },
      },
    });
  } catch (err) {
    console.error(`Failed to send push to ${userId}:`, err.message);
  }
}

function fmt(amount) {
  return `$${Number(amount || 0).toFixed(2)}`;
}

// ── Triggers ────────────────────────────────────────────────────────────

// New expense added → notify Cameron
exports.onExpenseCreated = onDocumentCreated("expenses/{id}", async (event) => {
  const exp = event.data?.data();
  if (!exp) return;
  const desc = exp.description || "New charge";
  const amount = exp.split === "split"
    ? Number(exp.amount || 0) / 2
    : Number(exp.amount || 0);
  await sendPush("cam", "New Charge Added", `${desc} — ${fmt(amount)} your share`, {
    screen: "dashboard",
  });
});

// New payment created
exports.onPaymentCreated = onDocumentCreated("payments/{id}", async (event) => {
  const pmt = event.data?.data();
  if (!pmt) return;

  if (pmt.type === "dispute") {
    // Cameron filed a dispute — notify Emma
    const desc = pmt.disputeDescription || "a charge";
    const reason = pmt.disputeReason ? ` — "${pmt.disputeReason}"` : "";
    await sendPush("emma", "Cameron Disputed a Charge", `${desc}${reason}`, {
      screen: "dashboard",
    });
  } else {
    // Cameron logged a payment — notify Emma to confirm
    await sendPush("emma", "Payment Needs Confirmation", `Cameron sent ${fmt(pmt.amount)} via ${pmt.method || "unknown"}`, {
      screen: "dashboard",
    });
  }
});

// Payment updated (confirmed, rejected, dispute resolved)
exports.onPaymentUpdated = onDocumentUpdated("payments/{id}", async (event) => {
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  if (!before || !after) return;

  // Payment confirmed by Emma → notify Cameron
  if (!before.confirmed && after.confirmed && after.type !== "dispute") {
    await sendPush("cam", "Payment Confirmed", `Emmanuella confirmed your ${fmt(after.amount)} ${after.method || ""} payment`, {
      screen: "dashboard",
    });
    return;
  }

  // Payment rejected/returned by Emma → notify Cameron
  if (!before.rejected && after.rejected) {
    const reason = after.rejectionReason ? `: "${after.rejectionReason}"` : "";
    await sendPush("cam", "Payment Returned", `Emmanuella returned your ${fmt(after.amount)} payment${reason}`, {
      screen: "dashboard",
    });
    return;
  }

  // Dispute resolved by Emma → notify Cameron
  if (!before.disputeStatus && after.disputeStatus) {
    const accepted = after.disputeStatus === "accepted";
    const msg = accepted
      ? `Your dispute for "${after.disputeDescription || "charge"}" was accepted`
      : `Your dispute was declined${after.declineReason ? ` — "${after.declineReason}"` : ""}`;
    await sendPush("cam", accepted ? "Dispute Accepted" : "Dispute Declined", msg, {
      screen: "dashboard",
    });
  }
});

// ── Daily due-date reminders → Cameron ──────────────────────────────────
// Runs every day at 9:00 AM Eastern
exports.dailyDueReminder = onSchedule("every day 09:00", async () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  function daysBetween(isoDate) {
    if (!isoDate) return null;
    const d = new Date(isoDate + "T00:00:00");
    return Math.round((d - today) / 86400000);
  }

  const snap = await db.collection("expenses").get();
  const expenses = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  for (const exp of expenses) {
    // Only expenses Cameron owes on
    if (exp.status === "paid") continue;
    const camOwes = exp.split === "cam" || exp.split === "split";
    if (!camOwes) continue;

    const dueDate = exp.nextDue || exp.dueDate;
    const days = daysBetween(dueDate);
    if (days === null) continue;

    const desc = exp.description || "An expense";
    const share = exp.split === "split"
      ? Number(exp.amount || 0) / 2
      : Number(exp.amount || 0);

    // Mandatory expenses: remind 2 days out
    if (exp.mandatory && days === 2) {
      await sendPush("cam", "Mandatory Expense Due in 2 Days", `${desc} — ${fmt(share)} due in 2 days`, {
        screen: "urgent",
      });
    }

    // All expenses (including mandatory): remind 1 day out
    if (days === 1) {
      const title = exp.mandatory ? "Mandatory Expense Due Tomorrow" : "Expense Due Tomorrow";
      await sendPush("cam", title, `${desc} — ${fmt(share)} due tomorrow`, {
        screen: "urgent",
      });
    }
  }
});
