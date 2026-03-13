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

// ── Recurring expense auto-renewal ──────────────────────────────────────
// When a recurring expense is marked paid, advance nextDue and reset to unpaid
exports.onRecurringExpensePaid = onDocumentUpdated("expenses/{id}", async (event) => {
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  if (!before || !after) return;

  // Only fire when status transitions to "paid"
  if (before.status === "paid" || after.status !== "paid") return;
  // Only for recurring expenses
  if (!after.recurring || after.recurring === "none") return;

  try {
    const baseDateStr = after.nextDue || after.dueDate;
    if (!baseDateStr) return;

    const base = new Date(baseDateStr + "T00:00:00");

    let next;
    switch (after.recurring) {
      case "weekly":
        next = new Date(base);
        next.setDate(next.getDate() + 7);
        break;
      case "biweekly":
        next = new Date(base);
        next.setDate(next.getDate() + 14);
        break;
      case "monthly":
        next = new Date(base);
        next.setMonth(next.getMonth() + 1);
        break;
      case "quarterly":
        next = new Date(base);
        next.setMonth(next.getMonth() + 3);
        break;
      case "yearly":
        next = new Date(base);
        next.setFullYear(next.getFullYear() + 1);
        break;
      default:
        return;
    }

    const pad = (n) => String(n).padStart(2, "0");
    const nextDueStr = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;

    await getFirestore().doc("expenses/" + event.params.id).update({
      status: "unpaid",
      nextDue: nextDueStr,
    });

    const desc = after.description || "Expense";
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const formattedDate = `${monthNames[next.getMonth()]} ${next.getDate()}`;
    await sendPush("cam", "Expense Renewed", `${desc} — next due ${formattedDate}`);
  } catch (err) {
    console.error("onRecurringExpensePaid error:", err.message);
  }
});

// ── Monthly summary notification ─────────────────────────────────────────
// Runs on the 1st of every month at 9 AM
exports.monthlySummary = onSchedule("0 9 1 * *", async () => {
  const now = new Date();

  // Previous month bounds
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 1); // exclusive

  const [expSnap, pmtSnap] = await Promise.all([
    db.collection("expenses").get(),
    db.collection("payments").get(),
  ]);

  const expenses = expSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const payments = pmtSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // totalReceived: confirmed payments with confirmedAt in the previous month
  let totalReceived = 0;
  for (const pmt of payments) {
    if (!pmt.confirmed || !pmt.confirmedAt) continue;
    const confirmedAt = pmt.confirmedAt.toDate ? pmt.confirmedAt.toDate() : new Date(pmt.confirmedAt);
    if (confirmedAt >= prevMonthStart && confirmedAt < prevMonthEnd) {
      totalReceived += Number(pmt.amount || 0);
    }
  }

  // totalCharged: expenses created in the previous month
  let totalCharged = 0;
  for (const exp of expenses) {
    if (!exp.createdAt) continue;
    const createdAt = exp.createdAt.toDate ? exp.createdAt.toDate() : new Date(exp.createdAt);
    if (createdAt >= prevMonthStart && createdAt < prevMonthEnd) {
      totalCharged += Number(exp.amount || 0);
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // unpaidCount: Cameron owes, not paid
  let unpaidCount = 0;
  // overdueCount: not paid and past due
  let overdueCount = 0;
  for (const exp of expenses) {
    if (exp.status === "paid") continue;
    const camOwes = exp.split === "cam" || exp.split === "split";
    if (camOwes) unpaidCount++;

    const dueDateStr = exp.nextDue || exp.dueDate;
    if (dueDateStr) {
      const due = new Date(dueDateStr + "T00:00:00");
      if (due < today) overdueCount++;
    }
  }

  await Promise.all([
    sendPush(
      "cam",
      "Monthly Summary",
      `Last month: ${fmt(totalReceived)} paid · ${unpaidCount} still open`
    ),
    sendPush(
      "emma",
      "Monthly Summary",
      `Received ${fmt(totalReceived)} · ${overdueCount} overdue · ${fmt(totalCharged)} charged`
    ),
  ]);
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
