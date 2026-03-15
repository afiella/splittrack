const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const crypto = require("crypto");
const http2  = require("http2");

initializeApp();

const db = getFirestore();

const apnsKey = defineSecret("APNS_PRIVATE_KEY");

// ── APNs direct sender ───────────────────────────────────────────────────

const APNS_KEY_ID  = "HJF56CX254";
const APNS_TEAM_ID = "58JUTXDX58";
const APNS_BUNDLE  = "com.splittrack.app";
// Development (sandbox) endpoint — matches aps-environment = development in entitlements
const APNS_HOST    = "https://api.development.push.apple.com";

// Cache JWT for up to 55 minutes (tokens valid 1 hour)
let _jwtCache = { token: null, exp: 0 };

function makeApnsJwt(privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  if (_jwtCache.token && _jwtCache.exp > now + 300) return _jwtCache.token;

  const header  = Buffer.from(JSON.stringify({ alg: "ES256", kid: APNS_KEY_ID })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: APNS_TEAM_ID, iat: now })).toString("base64url");
  const input   = `${header}.${payload}`;

  const sign = crypto.createSign("SHA256");
  sign.update(input);
  const sig = sign.sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" }).toString("base64url");

  const jwt = `${input}.${sig}`;
  _jwtCache = { token: jwt, exp: now + 3300 };
  return jwt;
}

function sendAPNs(deviceToken, title, body, data, privateKeyPem) {
  return new Promise((resolve, reject) => {
    const jwt = makeApnsJwt(privateKeyPem);

    const bodyObj = {
      aps: { alert: { title, body }, sound: "default", badge: 1 },
      ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    };
    const bodyStr = JSON.stringify(bodyObj);

    const client = http2.connect(APNS_HOST);
    client.on("error", (err) => { reject(err); });

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      "authorization": `bearer ${jwt}`,
      "apns-topic": APNS_BUNDLE,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(bodyStr),
    });

    let status;
    req.on("response", (headers) => { status = headers[":status"]; });

    let responseBody = "";
    req.on("data", (chunk) => { responseBody += chunk; });
    req.on("end", () => {
      client.close();
      if (status === 200) {
        resolve();
      } else {
        reject(new Error(`APNs ${status}: ${responseBody}`));
      }
    });
    req.on("error", (err) => { client.close(); reject(err); });

    req.write(bodyStr);
    req.end();
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function getTokens(userId) {
  const snap = await db.collection("deviceTokens").doc(userId).get();
  if (!snap.exists) return { nativeToken: null, webToken: null };
  const data = snap.data() || {};
  return {
    nativeToken: data.nativeToken || null,
    webToken: data.webToken || data.fcmToken || null,
  };
}

async function sendPush(userId, title, body, data = {}) {
  const { nativeToken, webToken } = await getTokens(userId);
  const privateKeyPem = apnsKey.value();

  const stringData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v)])
  );

  // Native token — send directly via APNs HTTP/2
  if (nativeToken) {
    console.log(`sendPush: APNs "${title}" → ${userId}`);
    try {
      await sendAPNs(nativeToken, title, body, stringData, privateKeyPem);
      return;
    } catch (err) {
      console.error(`sendPush: APNs failed for ${userId}:`, err.message);
      // fall through to web token
    }
  }

  // Web push token — data-only FCM message, service worker shows it
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

// ── Shared secret config for all triggers ────────────────────────────────
const fnOpts = { secrets: [apnsKey] };

// ── Triggers ────────────────────────────────────────────────────────────

exports.onExpenseCreated = onDocumentCreated({ document: "expenses/{id}", ...fnOpts }, async (event) => {
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

exports.onPaymentCreated = onDocumentCreated({ document: "payments/{id}", ...fnOpts }, async (event) => {
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

exports.onPaymentUpdated = onDocumentUpdated({ document: "payments/{id}", ...fnOpts }, async (event) => {
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

exports.onRecurringExpensePaid = onDocumentUpdated({ document: "expenses/{id}", ...fnOpts }, async (event) => {
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

exports.monthlySummary = onSchedule({ schedule: "0 9 1 * *", ...fnOpts }, async () => {
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

exports.dailyDueReminder = onSchedule({ schedule: "every day 09:00", ...fnOpts }, async () => {
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
