const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

const db = getFirestore();

// ── Helpers ─────────────────────────────────────────────────────────────

async function getTokens(userId) {
  const snap = await db.collection("deviceTokens").doc(userId).get();
  if (!snap.exists) return { nativeToken: null, webToken: null };
  const data = snap.data() || {};
  return {
    nativeToken: data.nativeToken || null,
    // webToken falls back to legacy fcmToken field
    webToken: data.webToken || data.fcmToken || null,
  };
}

async function sendPush(userId, title, body, data = {}) {
  const { nativeToken, webToken } = await getTokens(userId);

  const stringData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v)])
  );

  // Native (APNs) token — send with notification field so iOS displays it
  if (nativeToken) {
    console.log(`sendPush: native "${title}" → ${userId}`);
    try {
      await getMessaging().send({
        token: nativeToken,
        notification: { title, body },
        data: stringData,
        apns: {
          payload: { aps: { sound: "default", badge: 1 } },
        },
      });
      return; // delivered natively — skip web to avoid duplicate
    } catch (err) {
      console.error(`sendPush: native failed for ${userId}:`, err.message);
      // fall through to web token
    }
  }

  // Web push token — data-only so FCM does NOT auto-display a notification.
  // The service worker's onBackgroundMessage reads title/body from data and
  // calls showNotification itself — one notification, no duplicates.
  if (webToken) {
    console.log(`sendPush: web "${title}" → ${userId}`);
    try {
      await getMessaging().send({
        token: webToken,
        data: { ...stringData, title, body },
        webpush: { headers: { Urgency: "high" } },
      });
    } catch (err) {
      console.error(`sendPush: web failed for ${userId}:`, err.message);
    }
    return;
  }

  console.warn(`sendPush: no token for "${userId}" — open the app and accept notifications`);
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
    const desc = pmt.disputeDescription || "a charge";
    const reason = pmt.disputeReason ? ` — "${pmt.disputeReason}"` : "";
    await sendPush("emma", "Cameron Disputed a Charge", `${desc}${reason}`, {
      screen: "dashboard",
    });
  } else {
    await sendPush("emma", "Payment Needs Confirmation", `Cameron sent ${fmt(pmt.amount)} via ${pmt.method || "unknown"}`, {
      screen: "dashboard",
    });
  }
});

// Payment updated (confirmed, rejected, dispute resolved)
exports.onPaymentUpdated = onDocumentUpdated("payments/{id}", async (event) => {
  const before = event.data?.before?.data();
  const after  = event.data?.after?.data();
  if (!before || !after) return;

  if (!before.confirmed && after.confirmed && after.type !== "dispute") {
    await sendPush("cam", "Payment Confirmed", `Emmanuella confirmed your ${fmt(after.amount)} ${after.method || ""} payment`, {
      screen: "dashboard",
    });
    return;
  }

  if (!before.rejected && after.rejected) {
    const reason = after.rejectionReason ? `: "${after.rejectionReason}"` : "";
    await sendPush("cam", "Payment Returned", `Emmanuella returned your ${fmt(after.amount)} payment${reason}`, {
      screen: "dashboard",
    });
    return;
  }

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

// ── Recurring expense auto-renewal ──────────────────────────────────────
exports.onRecurringExpensePaid = onDocumentUpdated("expenses/{id}", async (event) => {
  const before = event.data?.before?.data();
  const after  = event.data?.after?.data();
  if (!before || !after) return;

  if (before.status === "paid" || after.status !== "paid") return;
  if (!after.recurring || after.recurring === "none") return;

  try {
    const baseDateStr = after.nextDue || after.dueDate;
    if (!baseDateStr) return;

    const base = new Date(baseDateStr + "T00:00:00");
    let next;
    switch (after.recurring) {
      case "weekly":    next = new Date(base); next.setDate(next.getDate() + 7);       break;
      case "biweekly":  next = new Date(base); next.setDate(next.getDate() + 14);      break;
      case "monthly":   next = new Date(base); next.setMonth(next.getMonth() + 1);     break;
      case "quarterly": next = new Date(base); next.setMonth(next.getMonth() + 3);     break;
      case "yearly":    next = new Date(base); next.setFullYear(next.getFullYear()+1);  break;
      default: return;
    }

    const pad = (n) => String(n).padStart(2, "0");
    const nextDueStr = `${next.getFullYear()}-${pad(next.getMonth()+1)}-${pad(next.getDate())}`;

    await getFirestore().doc("expenses/" + event.params.id).update({
      status: "unpaid",
      nextDue: nextDueStr,
    });

    const desc = after.description || "Expense";
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    await sendPush("cam", "Expense Renewed", `${desc} — next due ${months[next.getMonth()]} ${next.getDate()}`);
  } catch (err) {
    console.error("onRecurringExpensePaid error:", err.message);
  }
});

// ── Monthly summary — 1st of every month at 9 AM ─────────────────────────
exports.monthlySummary = onSchedule("0 9 1 * *", async () => {
  const now = new Date();
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 1);

  const [expSnap, pmtSnap] = await Promise.all([
    db.collection("expenses").get(),
    db.collection("payments").get(),
  ]);

  const expenses = expSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const payments = pmtSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  let totalReceived = 0;
  for (const pmt of payments) {
    if (!pmt.confirmed || !pmt.confirmedAt) continue;
    const confirmedAt = pmt.confirmedAt.toDate ? pmt.confirmedAt.toDate() : new Date(pmt.confirmedAt);
    if (confirmedAt >= prevMonthStart && confirmedAt < prevMonthEnd)
      totalReceived += Number(pmt.amount || 0);
  }

  let totalCharged = 0;
  for (const exp of expenses) {
    if (!exp.createdAt) continue;
    const createdAt = exp.createdAt.toDate ? exp.createdAt.toDate() : new Date(exp.createdAt);
    if (createdAt >= prevMonthStart && createdAt < prevMonthEnd)
      totalCharged += Number(exp.amount || 0);
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  let unpaidCount = 0, overdueCount = 0;
  for (const exp of expenses) {
    if (exp.status === "paid") continue;
    if (exp.split === "cam" || exp.split === "split") unpaidCount++;
    const due = exp.nextDue || exp.dueDate;
    if (due && new Date(due + "T00:00:00") < today) overdueCount++;
  }

  await Promise.all([
    sendPush("cam",  "Monthly Summary", `Last month: ${fmt(totalReceived)} paid · ${unpaidCount} still open`),
    sendPush("emma", "Monthly Summary", `Received ${fmt(totalReceived)} · ${overdueCount} overdue · ${fmt(totalCharged)} charged`),
  ]);
});

// ── Daily due-date reminders → Cameron ──────────────────────────────────
exports.dailyDueReminder = onSchedule("every day 09:00", async () => {
  const today = new Date(); today.setHours(0, 0, 0, 0);

  function daysBetween(isoDate) {
    if (!isoDate) return null;
    return Math.round((new Date(isoDate + "T00:00:00") - today) / 86400000);
  }

  const snap = await db.collection("expenses").get();
  const expenses = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  for (const exp of expenses) {
    if (exp.status === "paid") continue;
    if (!(exp.split === "cam" || exp.split === "split")) continue;

    const days = daysBetween(exp.nextDue || exp.dueDate);
    if (days === null) continue;

    const desc = exp.description || "An expense";
    const share = exp.split === "split"
      ? Number(exp.amount || 0) / 2
      : Number(exp.amount || 0);

    if (exp.mandatory && days === 2)
      await sendPush("cam", "Mandatory Expense Due in 2 Days", `${desc} — ${fmt(share)} due in 2 days`, { screen: "urgent" });

    if (days === 1) {
      const title = exp.mandatory ? "Mandatory Expense Due Tomorrow" : "Expense Due Tomorrow";
      await sendPush("cam", title, `${desc} — ${fmt(share)} due tomorrow`, { screen: "urgent" });
    }
  }
});

