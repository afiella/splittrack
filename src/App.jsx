import { useState, useEffect, useRef } from "react";
import { onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut, setPersistence, browserLocalPersistence } from "firebase/auth";
import { listenExpenses, listenPayments, addExpense, addPayment, confirmPayment as confirmPaymentInDb, deleteExpense as deleteExpenseInDb, deletePayment as deletePaymentInDb, updateExpense as updateExpenseInDb, } from "./data";
import { auth } from "./firebase";
// ── MOCK DATA ─────────────────────────────────────────────────────────
const INITIAL_EXPENSES = [
  { description: "Elephant Insurance (Cam's card)", amount: 309.93, split: "cam", date: "2025-11-03", account: "Best Buy Visa", category: "Insurance", status: "unpaid" },
  { description: "YouTube Premium", amount: 8.50, split: "cam", date: "2026-03-01", account: "Navy Platinum", category: "Subscriptions", status: "unpaid" },
  { description: "7-Eleven (Cam's card)", amount: 10.00, split: "cam", date: "2025-09-18", account: "Best Buy Visa", category: "Other", status: "unpaid" },
  { description: "Groceries — Wegmans", amount: 120.00, split: "split", date: "2026-02-28", account: "Navy Platinum", category: "Groceries", status: "unpaid" },
  { description: "Household supplies", amount: 45.00, split: "split", date: "2026-02-20", account: "Navy Platinum", category: "Household", status: "unpaid" },
];

const INITIAL_PAYMENTS = [
  { amount: 50.00, date: "2026-02-15", method: "Zelle", note: "Partial for insurance", confirmed: true },
];

const SPLIT_LABELS = { mine: "I pay", cam: "Cam pays", ella: "Emmanuella pays", split: "Split 50/50" };
const SPLIT_COLORS = { mine: "#7BBFB0", cam: "#E8A0B0", ella: "#7BBFB0", split: "#C4A8D4" };
const CATEGORIES = ["Groceries", "Household", "Insurance", "Subscriptions", "Utilities", "Entertainment", "Other"];

// ── AUTH ROLE MAPPING ─────────────────────────────────────────────────
// TODO: Replace these with your real Gmail addresses
const EMMA_EMAILS = ["ellabellosei@gmail.com"]; // full access
const CAM_EMAILS = ["camstayflat@gmail.com"];   // limited access

function roleFromEmail(email) {
  if (!email) return null;
  const e = String(email).toLowerCase();
  if (EMMA_EMAILS.map(x => x.toLowerCase()).includes(e)) return "emma";
  if (CAM_EMAILS.map(x => x.toLowerCase()).includes(e)) return "cam";
  // default: treat unknown accounts as limited
  return "cam";
}

// Unified target summaries for payment application (plans + one-time expenses)
function calcTargetSummaries(expenses, payments) {
  const list = expenses || [];
  const pays = payments || [];

  function applySplit(e, baseAmount) {
    if (e.split === "cam") return baseAmount;
    if (e.split === "split") return baseAmount / 2;
    if (e.split === "ella") return -baseAmount;
    return 0;
  }

  // Confirmed payments allocated to a target key
  const paidByKey = new Map();
  for (const p of pays) {
    if (!p?.confirmed) continue;
    const key = p.appliedToKey || (p.appliedToGroupId ? `grp:${p.appliedToGroupId}` : "general");
    if (!key || key === "general") continue;
    paidByKey.set(key, (paidByKey.get(key) || 0) + Number(p.amount || 0));
  }

  const summaries = new Map();

  // Plans (recurring) grouped by groupId
  const groups = new Map();
  for (const e of list) {
    const isRecurring = e.recurring && e.recurring !== "none";
    const gid = isRecurring ? (e.groupId || e.id) : null;
    if (!gid) continue;
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push(e);
  }

  for (const [gid, items] of groups) {
    const sorted = [...items].sort((a, b) => {
      const da = a.dueDate || a.nextDue || "9999-99-99";
      const db = b.dueDate || b.nextDue || "9999-99-99";
      return da.localeCompare(db);
    });
    const t = sorted[0];

    const startDue = t.dueDate || t.nextDue;
    const freq = t.recurring;
    const endDate = t.endDate || null;
    const repeatCount = typeof t.repeatCount === "number" ? t.repeatCount : null;
    const occurrences = countOccurrences({ startDue, frequency: freq, endDate, repeatCount });

    const perOccurrence = applySplit(t, Number(t.amount || 0));
    const charged = perOccurrence * occurrences;

    const paidFromExpenses = items
      .filter((e) => e.status === "paid")
      .reduce((s, e) => s + applySplit(e, Number(e.amount || 0)), 0);

    const key = `grp:${gid}`;
    const paidFromPayments = paidByKey.get(key) || 0;

    const paidTotal = paidFromExpenses + paidFromPayments;
    const remaining = charged - paidTotal;
    const suggested = Math.max(0, Math.min(Math.abs(remaining), Math.abs(perOccurrence)));

    summaries.set(key, {
      key,
      kind: "plan",
      label: t.description,
      charged,
      paid: paidTotal,
      remaining,
      suggested,
    });
  }

  // One-time expenses as targets
  for (const e of list) {
    const isRecurring = e.recurring && e.recurring !== "none";
    if (isRecurring) continue;
    if (!e.id) continue;

    const key = `exp:${e.id}`;
    const charged = applySplit(e, Number(e.amount || 0));
    const paidFromPayments = paidByKey.get(key) || 0;

    // If Emmanuella marks a one-time expense as paid, treat it as fully paid.
    const paidFromMarkPaid = e.status === "paid" ? charged : 0;

    // Cap paid to the charged amount (prevents double counting)
    const paidTotal = Math.max(0, Math.min(Math.abs(charged), Math.abs(paidFromPayments + paidFromMarkPaid))) * (charged < 0 ? -1 : 1);

    const remaining = charged - paidTotal;
    const suggested = Math.max(0, Math.min(Math.abs(remaining), Math.abs(charged)));

    summaries.set(key, {
      key,
      kind: "expense",
      label: e.description,
      charged,
      paid: paidTotal,
      remaining,
      suggested,
    });
  }

  return summaries;
}

// Compute totalPaid from targetSummaries plus any confirmed "general" payments
function calcTotalPaidFromTargets(payments, targetSummaries) {
  const pays = payments || [];

  // Payments not assigned to a target
  const generalPaid = pays
    .filter((p) => p?.confirmed)
    .filter((p) => {
      const key = p.appliedToKey || (p.appliedToGroupId ? `grp:${p.appliedToGroupId}` : "general");
      return !key || key === "general";
    })
    .reduce((s, p) => s + Number(p.amount || 0), 0);

  let targetedPaid = 0;
  if (targetSummaries) {
    for (const s of targetSummaries.values()) {
      const charged = Number(s.charged || 0);
      const paid = Number(s.paid || 0);
      // Cap so we never count more paid than charged for the target
      const capped = Math.max(0, Math.min(Math.abs(charged), Math.abs(paid))) * (charged < 0 ? -1 : 1);
      targetedPaid += capped;
    }
  }

  return generalPaid + targetedPaid;
}

function formatShortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}


function formatHistoryDate(isoOrDate) {
  if (!isoOrDate) return "";
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return String(isoOrDate);
  const mon = d.toLocaleDateString("en-US", { month: "short" });
  const day = d.getDate();
  const yr = d.getFullYear();
  return `${mon} · ${day} · ${yr}`;
}

// ── SEARCH FRAMEWORK (web) ───────────────────────────────────────────
function useExpensesSearchLogic(expenses) {
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filteredExpenses, setFilteredExpenses] = useState(expenses || []);

  // keep filtered list synced if the base list changes
  useEffect(() => {
    const list = expenses || [];
    const q = String(searchQuery || "").trim().toLowerCase();

    if (!searchActive) {
      setFilteredExpenses(list);
      return;
    }

    // If searching, keep results up-to-date when the base list changes
    if (!q) {
      setFilteredExpenses(list);
      return;
    }

    setFilteredExpenses(
      list.filter((e) => {
        const d = String(e.description || "").toLowerCase();
        const c = String(e.category || "").toLowerCase();
        const a = String(e.account || "").toLowerCase();
        const amt = String(e.amount ?? "").toLowerCase();
        const due = String(e.nextDue || e.dueDate || "").toLowerCase();
        return d.includes(q) || c.includes(q) || a.includes(q) || amt.includes(q) || due.includes(q);
      })
    );
  }, [expenses, searchActive, searchQuery]);

  function activateSearch() {
    setSearchActive(true);
  }

  function cancelSearch() {
    setSearchActive(false);
    setSearchQuery("");
    setFilteredExpenses(expenses || []);
  }

  function clearSearch() {
    setSearchQuery("");
    setFilteredExpenses(expenses || []);
  }

  function handleSearch(text) {
    setSearchQuery(text);
    const q = String(text || "").trim().toLowerCase();
    if (!q) {
      setFilteredExpenses(expenses || []);
      return;
    }

    const results = (expenses || []).filter((e) => {
      const d = String(e.description || "").toLowerCase();
      const c = String(e.category || "").toLowerCase();
      const a = String(e.account || "").toLowerCase();
      const amt = String(e.amount ?? "").toLowerCase();
      const due = String(e.nextDue || e.dueDate || "").toLowerCase();
      return d.includes(q) || c.includes(q) || a.includes(q) || amt.includes(q) || due.includes(q);
    });

    setFilteredExpenses(results);
  }

  return {
    searchActive,
    searchQuery,
    filteredExpenses,
    activateSearch,
    cancelSearch,
    clearSearch,
    handleSearch,
  };
}

// Helper: Parse YYYY-MM-DD as local date
function parseLocalISODate(iso) {
  if (!iso) return null;
  const [yy, mm, dd] = String(iso).split("-").map((x) => parseInt(x, 10));
  if (!yy || !mm || !dd) return null;
  return new Date(yy, mm - 1, dd);
}

function toISODateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addByFrequency(isoDate, frequency) {
  const d = parseLocalISODate(isoDate);
  if (!d) return null;
  if (frequency === "weekly") d.setDate(d.getDate() + 7);
  if (frequency === "biweekly") d.setDate(d.getDate() + 14);
  if (frequency === "monthly") d.setMonth(d.getMonth() + 1);
  return toISODateLocal(d);
}

function countOccurrences({ startDue, frequency, endDate, repeatCount }) {
  // Prefer explicit repeatCount if provided
  if (typeof repeatCount === "number" && repeatCount > 0) return repeatCount;
  if (!startDue || !frequency || frequency === "none") return 1;
  if (!endDate) return 1;

  // Count inclusive occurrences: startDue, startDue+freq, ... <= endDate
  let count = 0;
  let cur = startDue;
  // guard against infinite loops
  for (let i = 0; i < 500; i++) {
    if (!cur) break;
    if (cur > endDate) break;
    count += 1;
    cur = addByFrequency(cur, frequency);
  }
  return count || 1;
}


// ── CALCULATIONS ──────────────────────────────────────────────────────
function calcCharged(expenses) {
  const list = expenses || [];

  // Helper: apply split logic to a base amount
  function applySplit(e, baseAmount) {
    if (e.split === "cam") return baseAmount;
    if (e.split === "split") return baseAmount / 2;
    if (e.split === "ella") return -baseAmount;
    return 0;
  }

  // Group recurring expenses by groupId so we count the plan once.
  const groups = new Map();
  const singles = [];

  for (const e of list) {
    const isRecurring = e.recurring && e.recurring !== "none";
    const gid = isRecurring ? (e.groupId || e.id) : null;

    if (isRecurring && gid) {
      if (!groups.has(gid)) groups.set(gid, []);
      groups.get(gid).push(e);
    } else {
      singles.push(e);
    }
  }

  let sum = 0;

  // Add one-time expenses as-is
  for (const e of singles) {
    sum += applySplit(e, Number(e.amount || 0));
  }

  // Add recurring plans once per group
  for (const [, items] of groups) {
    // Pick a stable template: earliest due/nextDue/dueDate
    const sorted = [...items].sort((a, b) => {
      const da = a.dueDate || a.nextDue || "9999-99-99";
      const db = b.dueDate || b.nextDue || "9999-99-99";
      return da.localeCompare(db);
    });
    const t = sorted[0];

    const startDue = t.dueDate || t.nextDue;
    const freq = t.recurring;
    const endDate = t.endDate || null;
    const repeatCount = typeof t.repeatCount === "number" ? t.repeatCount : null;

    const occurrences = countOccurrences({ startDue, frequency: freq, endDate, repeatCount });
    const baseTotal = Number(t.amount || 0) * occurrences;

    sum += applySplit(t, baseTotal);
  }

  return sum;
}

function calcPlanSummaries(expenses, payments) {
  const list = expenses || [];
  const pays = payments || [];

  function applySplit(e, baseAmount) {
    if (e.split === "cam") return baseAmount;
    if (e.split === "split") return baseAmount / 2;
    if (e.split === "ella") return -baseAmount;
    return 0;
  }

  // Group recurring expenses by groupId
  const groups = new Map();
  for (const e of list) {
    const isRecurring = e.recurring && e.recurring !== "none";
    const gid = isRecurring ? (e.groupId || e.id) : null;
    if (!gid) continue;
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push(e);
  }

  // Confirmed payments allocated to a group
  const paidByGroup = new Map();
  for (const p of pays) {
    if (!p?.confirmed) continue;
    const gid = p.appliedToGroupId || "general";
    if (!gid || gid === "general") continue;
    paidByGroup.set(gid, (paidByGroup.get(gid) || 0) + Number(p.amount || 0));
  }

  const summaries = new Map();

  for (const [gid, items] of groups) {
    const sorted = [...items].sort((a, b) => {
      const da = a.dueDate || a.nextDue || "9999-99-99";
      const db = b.dueDate || b.nextDue || "9999-99-99";
      return da.localeCompare(db);
    });
    const t = sorted[0];

    const startDue = t.dueDate || t.nextDue;
    const freq = t.recurring;
    const endDate = t.endDate || null;
    const repeatCount = typeof t.repeatCount === "number" ? t.repeatCount : null;
    const occurrences = countOccurrences({ startDue, frequency: freq, endDate, repeatCount });

    const perOccurrence = applySplit(t, Number(t.amount || 0));
    const charged = perOccurrence * occurrences;

    // If you mark occurrences as paid, count them toward progress too.
    const paidFromExpenses = items
      .filter((e) => e.status === "paid")
      .reduce((s, e) => s + applySplit(e, Number(e.amount || 0)), 0);

    const paidFromPayments = paidByGroup.get(gid) || 0;

    const paidTotal = paidFromExpenses + paidFromPayments;
    const remaining = charged - paidTotal;

    const suggested = Math.max(0, Math.min(Math.abs(remaining), Math.abs(perOccurrence)));

    summaries.set(gid, {
      groupId: gid,
      label: t.description,
      charged,
      paid: paidTotal,
      remaining,
      suggested,
    });
  }

  return summaries;
}

function calcPaidExpenses(expenses) {
  // Count PAID expenses as "paid" toward the total.
  return (expenses || [])
    .filter((e) => e.status === "paid")
    .reduce((sum, e) => {
      if (e.split === "cam") return sum + e.amount;
      if (e.split === "split") return sum + e.amount / 2;
      if (e.split === "ella") return sum - e.amount;
      return sum;
    }, 0);
}

function calcPaid(payments) {
  return payments.filter(p => p.confirmed).reduce((sum, p) => sum + p.amount, 0);
}

function getDaysUntilDue(dueDate) {
  if (!dueDate) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const d = new Date(dueDate); d.setHours(0, 0, 0, 0);
  return Math.floor((d - t) / 86400000);
}

function getUrgencyLevel(e) {
  if (!(e?.nextDue || e?.dueDate) || e.status === "paid") return null;
  if (!["cam", "split"].includes(e.split)) return null;
  const days = getDaysUntilDue(e.nextDue || e.dueDate);
  if (days === null) return null;
  if (days < 0) return "overdue";
  if (days <= 3) return "critical";
  if (days <= 7) return "warning";
  return null;
}

function getNextDueDate(currentDue, frequency) {
  // Parse YYYY-MM-DD as a *local* date to avoid timezone shifting.
  const [yy, mm, dd] = String(currentDue).split("-").map((x) => parseInt(x, 10));
  const d = new Date(yy, (mm || 1) - 1, dd || 1);

  if (frequency === "weekly") d.setDate(d.getDate() + 7);
  if (frequency === "biweekly") d.setDate(d.getDate() + 14);
  if (frequency === "monthly") d.setMonth(d.getMonth() + 1);

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}


const URGENCY = {
  overdue:  { bg: "#FFF0F0", border: "#E8A0B0", badge: "#E05C6E", label: "OVERDUE" },
  critical: { bg: "#FFF5EC", border: "#F4A05A", badge: "#E07820", label: "DUE SOON" },
  warning:  { bg: "#FFFBE6", border: "#E8C878", badge: "#C8A020", label: "UPCOMING" },
};

// ── ICONS ─────────────────────────────────────────────────────────────
const icons = {
  home: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6",
  plus: "M12 4v16m8-8H4",
  list: "M4 6h16M4 10h16M4 14h16M4 18h16",
  check: "M5 13l4 4L19 7",
  clock: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
  wallet: "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z",
  back: "M15 19l-7-7 7-7",
  x: "M6 18L18 6M6 6l12 12",
  alert: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
  fire: "M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z",
  forward:     "M9 5l7 7-7 7",
  chevronDown: "M19 9l-7 7-7-7",
  chevronUp:   "M5 15l7-7 7 7",
  plusCircle:  "M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z",
  search:      "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z",
  trash:       "M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16",
};

function Icon({ path, size = 20, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────────
export default function App() {
  const [firebaseUser, setFirebaseUser] = useState(null);
  const user = roleFromEmail(firebaseUser?.email); // "emma" | "cam"
  const [screen, setScreen] = useState("dashboard");
  const [activeTargetKey, setActiveTargetKey] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [payments, setPayments] = useState([]);
  const [notification, setNotification] = useState(null);
  const [modal, setModal] = useState(null); // "addExpense" | "logPayment" | "confirmPayment"
  
  const [paymentDraftKey, setPaymentDraftKey] = useState("general");
  useEffect(() => {
    // Keep the user signed in across reloads
    setPersistence(auth, browserLocalPersistence).catch((e) => {
      console.warn("Auth persistence not set:", e);
    });

    const unsub = onAuthStateChanged(auth, (u) => setFirebaseUser(u));
    return () => unsub();
  }, []);

  useEffect(() => {
    const unsubExpenses = listenExpenses(setExpenses);
    const unsubPayments = listenPayments(setPayments);
    return () => {
      unsubExpenses();
      unsubPayments();
    };
  }, []);

  const planSummaries = calcPlanSummaries(expenses, payments);
  const targetSummaries = calcTargetSummaries(expenses, payments);

  const totalCharged = calcCharged(expenses);
  const totalPaid = calcTotalPaidFromTargets(payments, targetSummaries);
  const balance = totalCharged - totalPaid;

  const urgentExpenses = expenses.filter((e) => getUrgencyLevel(e) !== null);
  const urgentCount = urgentExpenses.length;

  const paymentTargets = (() => {
    const planMap = new Map();
    const expMap = new Map();

    for (const e of expenses) {
      const isRecurring = e.recurring && e.recurring !== "none";

      if (isRecurring) {
        const gid = e.groupId || e.id;
        if (!gid) continue;
        if (!planMap.has(gid)) {
          planMap.set(gid, { key: `grp:${gid}`, label: e.description });
        }
      } else {
        // one-time unpaid expense target
        if (!e.id) continue;
        if (e.status === "paid") continue;
        if (!expMap.has(e.id)) {
          expMap.set(e.id, { key: `exp:${e.id}`, label: e.description });
        }
      }
    }

    return [
      { key: "general", label: "General (not assigned)" },
      ...planMap.values(),
      ...expMap.values(),
    ];
  })();

  const syncingPayments = payments.some((p) => p && p._optimistic);


  function notify(msg, type = "success") {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 3000);
  }

  async function handleAddExpense(data) {
    const tempId = `tmp-exp-${Date.now()}`;
    const exp = { ...data, status: "unpaid" };
    // If this is a recurring plan, assign a stable groupId so all occurrences link together.
    if (exp.recurring && exp.recurring !== "none" && !exp.groupId) {
      exp.groupId = `grp-${Date.now()}`;
    }

    // Optimistic UI: show immediately
    setExpenses((prev) => [{ ...exp, id: tempId, _optimistic: true }, ...prev]);

    try {
      await addExpense(exp);
      setModal(null);
      notify("Expense added!");
      // Firestore listener will replace optimistic item with the real record.
    } catch (err) {
      console.error("Failed to add expense:", err);
      // Roll back optimistic item
      setExpenses((prev) => prev.filter((e) => e.id !== tempId));
      notify("Couldn't save expense. Check Firestore rules.", "error");
    }
  }

  async function handleLogPayment(data) {
    const tempId = `tmp-pay-${Date.now()}`;
    const pmt = { ...data, confirmed: false };

    // Optimistic UI: show immediately
    setPayments((prev) => [{ ...pmt, id: tempId, _optimistic: true }, ...prev]);

    try {
      await addPayment(pmt);
      setModal(null);
      notify(user === "cam" ? "Payment logged! Waiting for confirmation." : "Payment recorded!");
      // Firestore listener will replace optimistic item with the real record.
    } catch (err) {
      console.error("Failed to log payment:", err);
      // Roll back optimistic item
      setPayments((prev) => prev.filter((p) => p.id !== tempId));
      notify("Couldn't save payment. Check Firestore rules.", "error");
    }
  }

  async function handleConfirm(id) {
    try {
      const pmt = payments.find((p) => p && p.id === id) || null;
      await confirmPaymentInDb(id);

      // If this payment was applied to a specific one-time expense, and it fully covers the remaining,
      // automatically mark that expense as paid.
      const key = pmt?.appliedToKey || (pmt?.appliedToGroupId ? `grp:${pmt.appliedToGroupId}` : "general");
      if (user === "emma" && key && key.startsWith("exp:")) {
        const expId = key.slice(4);
        // Simulate the payment being confirmed locally to compute the new remaining
        const nextPays = payments.map((p) => (p && p.id === id ? { ...p, confirmed: true } : p));
        const summaries = calcTargetSummaries(expenses, nextPays);
        const s = summaries.get(key);
        const remaining = Number(s?.remaining ?? 0);

        // If remaining is effectively 0, mark the expense as paid
        if (Math.abs(remaining) < 0.01) {
          const paidAt = new Date().toISOString();
          try {
            await updateExpenseInDb(expId, { status: "paid", paidAt });
            notify("Payment confirmed — expense marked paid ✓");
            return;
          } catch (e) {
            console.error("Failed to mark expense paid after confirmation:", e);
            // Fall through to normal confirm toast
          }
        }
      }

      notify("Payment confirmed! ✓");
    } catch (err) {
      console.error("Failed to confirm payment:", err);
      notify("Couldn't confirm payment. Check Firestore rules.", "error");
    }
  }


  async function handleDeleteConfirmedPayment(id) {
    if (user !== "emma") return;

    const payment = payments.find((p) => p.id === id);
    if (!payment || !payment.confirmed) return;

    const ok = window.confirm("Delete this confirmed payment? This cannot be undone.");
    if (!ok) return;

    // Optimistic UI: remove immediately
    const removed = payment;
    setPayments((prev) => prev.filter((p) => p.id !== id));

    try {
      await deletePaymentInDb(id);
      notify("Payment deleted.");
    } catch (err) {
      console.error("Failed to delete payment:", err);
      // Roll back
      setPayments((prev) => [removed, ...prev]);
      notify("Couldn't delete payment. Check Firestore rules.", "error");
    }
  }

  async function handleMarkPaid(id) {
    if (user !== "emma") return;

    const ok = window.confirm("Mark this expense as paid?");
    if (!ok) return;

    const prevItem = expenses.find((e) => e.id === id) || null;
    const paidAt = new Date().toISOString();

    try {
      const item = expenses.find((e) => e.id === id);
      if (!item || item._optimistic) {
  notify("Still syncing that expense — try again in a second.", "error");
  return;
}

      if (item?.recurring && item.recurring !== "none") {
        const justPaidDue = item.nextDue || item.dueDate;
        const nextDue = getNextDueDate(justPaidDue, item.recurring);

        const remaining =
          typeof item.repeatCountRemaining === "number"
            ? item.repeatCountRemaining
            : typeof item.repeatCount === "number"
            ? item.repeatCount
            : null;

        const endDate = item.endDate || null;
        const nextDueExceedsEnd = endDate ? nextDue > endDate : false;
        const isLastByCount = remaining !== null ? remaining <= 1 : false;

        // Optimistic: mark CURRENT instance paid and _marking:true
        setExpenses((prev) =>
          prev.map((e) =>
            e.id === id
              ? { ...e, status: "paid", paidAt, lastPaidAt: paidAt, lastPaidDue: justPaidDue, _marking: true }
              : e
          )
        );

        await updateExpenseInDb(id, {
          status: "paid",
          paidAt,
          lastPaidAt: paidAt,
          lastPaidDue: justPaidDue,
        });
        // Clear _marking after update
        setExpenses((prev) => prev.map((e) => (e.id === id ? { ...e, _marking: false } : e)));

        // Stop recurring if we've reached the end condition
        if (isLastByCount || nextDueExceedsEnd) {
          notify("Marked paid — recurring complete");
          return;
        }

        // Otherwise create NEXT instance as a brand-new expense
        const nextRemaining = remaining !== null ? remaining - 1 : null;
        const newExp = {
          description: item.description,
          groupId: item.groupId || item.id,
          amount: item.amount,
          split: item.split,
          date: new Date().toISOString().split("T")[0],
          dueDate: nextDue,
          nextDue,
          account: item.account,
          category: item.category,
          status: "unpaid",
          recurring: item.recurring,
          ...(item.endDate ? { endDate: item.endDate } : {}),
          ...(typeof item.repeatCount === "number" ? { repeatCount: item.repeatCount } : {}),
          ...(nextRemaining !== null ? { repeatCountRemaining: nextRemaining } : {}),
        };

        const tempId = `tmp-exp-${Date.now()}`;
        setExpenses((prev) => [{ ...newExp, id: tempId, _optimistic: true }, ...prev]);

        await addExpense(newExp);
        notify("Marked paid — next due created for " + formatHistoryDate(nextDue));
      } else {
        // Optimistic UI: non-recurring becomes paid and _marking:true
        setExpenses((prev) =>
          prev.map((e) => (e.id === id ? { ...e, status: "paid", paidAt, _marking: true } : e))
        );

        await updateExpenseInDb(id, { status: "paid", paidAt });
        setExpenses((prev) => prev.map((e) => (e.id === id ? { ...e, _marking: false } : e)));
        notify("Marked as paid.");
      }
    } catch (err) {
      console.error("Failed to mark paid:", err);
      // Roll back
      if (prevItem) {
        setExpenses((prev) => prev.map((e) => (e.id === id ? prevItem : e)));
      }
      notify("Couldn't mark as paid. Check Firestore rules.", "error");
    }
  }


  async function handleDeleteExpense(id) {
    if (user !== "emma") return;

    const ok = window.confirm("Delete this expense? This cannot be undone.");
    if (!ok) return;

    // Optimistic UI: mark as deleting (keep row briefly so spinner is visible)
    const removed = expenses.find((e) => e.id === id) || null;
    setExpenses((prev) => prev.map((e) => (e.id === id ? { ...e, _deleting: true } : e)));

    // Remove after a short delay so the in-row spinner can render
    const startedAt = Date.now();
    const removeAfter = () => {
      setExpenses((prev) => prev.filter((e) => e.id !== id));
    };
    const wait = Math.max(0, 400 - (Date.now() - startedAt));
    if (wait > 0) setTimeout(removeAfter, wait);
    else removeAfter();

    try {
      await deleteExpenseInDb(id);
      notify("Expense deleted.");
      // Firestore listener will keep things synced.
    } catch (err) {
      console.error("Failed to delete expense:", err);
      // Roll back if it fails
      if (removed) {
        setExpenses((prev) => {
          const exists = prev.some((e) => e.id === id);
          if (exists) {
            return prev.map((e) => (e.id === id ? { ...removed } : e));
          }
          return [removed, ...prev];
        });
      }
      notify("Couldn't delete expense. Check Firestore rules.", "error");
    }
  }

  if (!firebaseUser) return <LoginScreen />;

  return (
    <div style={styles.app}>
      <style>{`@keyframes stSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      {/* Notification */}
      {notification && (
        <div style={{
          ...styles.notification,
          background: notification.type === "error" ? "#E8A0B0" : "#A8C5A0",
          color: notification.type === "error" ? "#7A1C3E" : "#1A4A2E",
        }}>
          {notification.msg}
        </div>
      )}

      {/* Modal */}
      {modal === "addExpense" && (
        <AddExpenseModal onSave={handleAddExpense} onClose={() => setModal(null)} user={user} />
      )}
      {modal === "logPayment" && (
        <LogPaymentModal
          balance={balance}
          onSave={handleLogPayment}
          onClose={() => { setModal(null); setPaymentDraftKey("general"); }}
          user={user}
          targets={paymentTargets}
          planSummaries={planSummaries}
          targetSummaries={targetSummaries}
          initialAppliedToKey={paymentDraftKey}
        />
      )}

      {/* Screen */}
      {screen === "dashboard" && (
        <DashboardScreen
          user={user}
          balance={balance}
          totalOwed={totalCharged}
          totalPaid={totalPaid}
          expenses={expenses}
          payments={payments}
          syncingPayments={syncingPayments}
          urgentCount={urgentCount}
          targetSummaries={targetSummaries}
          onOpenTarget={(key) => { setActiveTargetKey(key); setScreen("target"); }}
          onAddExpense={() => setModal("addExpense")}
          onLogPayment={() => setModal("logPayment")}
          onConfirm={handleConfirm}
          onDeleteExpense={handleDeleteExpense}
          onMarkPaid={handleMarkPaid}
          onNavigate={setScreen}
          onLogout={async () => { await signOut(auth); setScreen("dashboard"); }}
        />
      )}
      {screen === "target" && (
        <TargetDetailsScreen
          user={user}
          targetKey={activeTargetKey}
          targetSummaries={targetSummaries}
          expenses={expenses}
          payments={payments}
          onBack={() => { setScreen("dashboard"); setActiveTargetKey(null); }}
        />
      )}
      {screen === "history" && (
        <HistoryScreen
          expenses={expenses}
          payments={payments}
          user={user}
          onBack={() => setScreen("dashboard")}
          onConfirm={handleConfirm}
          onDeleteConfirmedPayment={handleDeleteConfirmedPayment}
          onDeleteExpense={handleDeleteExpense}
          targets={paymentTargets}
        />
      )}
      {screen === "expenses" && (
  <ExpensesScreen
    expenses={expenses}
    payments={payments}
    user={user}
    onBack={() => setScreen("dashboard")}
    onDeleteExpense={handleDeleteExpense}
    onMarkPaid={handleMarkPaid}
    targetSummaries={targetSummaries}
    onLogPaymentForKey={(key) => {
      const nextKey = key || "general";
      setPaymentDraftKey(nextKey);
      setModal("logPayment");
    }}
  />
)}
      {screen === "urgent" && (
  <UrgentScreen
    expenses={urgentExpenses}
    user={user}
    onBack={() => setScreen("dashboard")}
    onMarkPaid={handleMarkPaid}
  />
)}

      {/* Bottom Nav */}
      <BottomNav screen={screen} onNavigate={setScreen} urgentCount={urgentCount} />
    </div>
  );
}

// ── LOGIN SCREEN ──────────────────────────────────────────────────────
function LoginScreen() {
  async function handleGoogleSignIn() {
    const provider = new GoogleAuthProvider();
    // Show the Google account picker, then sign in.
    provider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(auth, provider);
  }

  return (
    <div style={styles.loginWrap}>
      <div style={styles.loginCard}>
        <div style={styles.loginLogo}>💸</div>
        <h1 style={styles.loginTitle}>SplitTrack</h1>
        <p style={styles.loginSubtitle}>Sign in to continue</p>
        <div style={styles.loginBtns}>
          <button
            style={{ ...styles.loginBtn, background: "linear-gradient(135deg, #7BBFB0, #5CA89A)" }}
            onClick={handleGoogleSignIn}
          >
            <span style={styles.loginBtnIcon}>🔐</span>
            <span>Sign in with Google</span>
            <span style={styles.loginBtnSub}>Secure</span>
          </button>
        </div>
        <p style={styles.loginNote}>
          After signing in, access level is based on your email.
        </p>
      </div>
    </div>
  );
}

// ── DASHBOARD MOCKUP (incremental) ───────────────────────────────────
// Step 1: mockup components (not rendered yet)
function DashboardPendingCard({ pendingPayments = [], onConfirm, user }) {
  if (user !== "emma") return null;

  const [selectedIds, setSelectedIds] = useState(() => new Set((pendingPayments || []).map((p) => p.id)));

  // Keep selection in sync with the latest pending list
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set();
      for (const p of pendingPayments) {
        if (prev.has(p.id) || prev.size === 0) next.add(p.id);
      }
      // If prev was empty (first load), default-select all
      if (prev.size === 0) {
        for (const p of pendingPayments) next.add(p.id);
      }
      return next;
    });
  }, [pendingPayments]);

  const selectedCount = selectedIds.size;

  async function confirmAll() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    // confirm sequentially to reduce Firestore contention
    for (const pid of ids) {
      // eslint-disable-next-line no-await-in-loop
      await onConfirm(pid);
    }
  }

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        background: "#fff",
        borderRadius: 20,
        padding: 14,
        boxShadow: "0 4px 16px rgba(30,15,69,0.09)",
        border: "1.5px solid #ede4f5",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#1e0f45", display: "flex", alignItems: "center", gap: 6 }}>
          <Icon path={icons.clock} size={12} color="#e8c878" />
          Pending
        </div>
        <span
          style={{
            background: "#e8c878",
            color: "#5a3a10",
            fontSize: 9,
            fontWeight: 800,
            padding: "2px 6px",
            borderRadius: 8,
          }}
        >
          {pendingPayments.length === 0 ? "0 pending" : `${selectedCount} selected`}
        </span>
      </div>

      {/* Scrollable list */}
      <div style={{ flex: 1, maxHeight: 112, overflowY: "auto" }}>
        {pendingPayments.length === 0 ? (
          <div
            style={{
              height: 112,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#888",
              fontSize: 12,
              fontWeight: 700,
              textAlign: "center",
            }}
          >
            No Pending Payments
          </div>
        ) : (
          pendingPayments.map((p) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                padding: "6px 0",
                borderBottom: "1px solid #faf7ff",
                gap: 8,
                cursor: "pointer",
              }}
              role="button"
              onClick={() =>
                setSelectedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(p.id)) next.delete(p.id);
                  else next.add(p.id);
                  return next;
                })
              }
            >
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 7,
                  flexShrink: 0,
                  border: selectedIds.has(p.id) ? "1.5px solid #7bbfb0" : "1.5px solid #d8eae7",
                  background: selectedIds.has(p.id) ? "#7bbfb0" : "#f5fffd",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {selectedIds.has(p.id) && <Icon path={icons.check} size={14} color="#fff" />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#1e0f45",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    margin: 0,
                  }}
                >
                  {p.method || "Payment"}
                </p>
                <p style={{ fontSize: 9, color: "#bbb", margin: "1px 0 0" }}>
                  {formatHistoryDate(p.date)} · Cam
                </p>
              </div>
              <p style={{ fontSize: 11, fontWeight: 700, color: "#1e0f45", flexShrink: 0, margin: 0 }}>
                ${Number(p.amount || 0).toFixed(2)}
              </p>
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    next.add(p.id);
                    return next;
                  });
                  onConfirm(p.id);
                }}
                style={{
                  marginLeft: 6,
                  background: "#7bbfb0",
                  border: "none",
                  borderRadius: 10,
                  padding: "6px 8px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                aria-label="Confirm payment"
                title="Confirm"
              >
                <Icon path={icons.check} size={14} color="#fff" />
              </button>
            </div>
          ))
        )}
      </div>

      {pendingPayments.length > 0 && (
        <button
          type="button"
          style={{
            width: "100%",
            marginTop: 8,
            background: "linear-gradient(135deg, #7bbfb0, #5ca898)",
            border: "none",
            borderRadius: 11,
            padding: 8,
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            opacity: selectedCount === 0 ? 0.55 : 1,
            cursor: selectedCount === 0 ? "default" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 5,
          }}
          onClick={confirmAll}
          disabled={selectedCount === 0}
        >
          <Icon path={icons.check} size={12} color="#fff" />
          Confirm {selectedCount || 0}
        </button>
      )}
    </div>
  );
}

function CamPendingCard({ pendingPayments = [], onOpenHistory }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => { if (typeof onOpenHistory === "function") onOpenHistory(); }}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          if (typeof onOpenHistory === "function") onOpenHistory();
        }
      }}
      style={{
        flex: 1,
        minWidth: 0,
        background: "#fff",
        borderRadius: 20,
        padding: 14,
        boxShadow: "0 4px 16px rgba(30,15,69,0.09)",
        border: "1.5px solid #ede4f5",
        display: "flex",
        flexDirection: "column",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#1e0f45", display: "flex", alignItems: "center", gap: 6 }}>
          <Icon path={icons.clock} size={12} color="#e8c878" />
          My Payments
        </div>
        <span
          style={{
            background: "#e8c878",
            color: "#5a3a10",
            fontSize: 9,
            fontWeight: 800,
            padding: "2px 6px",
            borderRadius: 8,
          }}
        >
          {pendingPayments.length} pending
        </span>
      </div>

      <div style={{ flex: 1, maxHeight: 112, overflowY: "auto" }}>
        {pendingPayments.length === 0 ? (
          <div
            style={{
              height: 112,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#888",
              fontSize: 12,
              fontWeight: 700,
              textAlign: "center",
            }}
          >
            No pending payments
          </div>
        ) : (
          pendingPayments.map((p) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                padding: "6px 0",
                borderBottom: "1px solid #faf7ff",
                gap: 8,
              }}
            >
              <div style={{ width: 7, height: 7, borderRadius: 999, background: "#e8c878", flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#1e0f45",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    margin: 0,
                  }}
                >
                  {p.method || "Payment"}
                </p>
                <p style={{ fontSize: 9, color: "#bbb", margin: "1px 0 0" }}>
                  {formatHistoryDate(p.date)} · You sent
                </p>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#1e0f45", margin: 0 }}>
                  ${Number(p.amount || 0).toFixed(2)}
                </p>
                <p style={{ fontSize: 9, color: "#bbb", margin: "2px 0 0" }}>Awaiting Ella</p>
              </div>
            </div>
          ))
        )}
      </div>

      <div
        style={{
          marginTop: 8,
          padding: "7px 10px",
          background: "#faf7ff",
          borderRadius: 10,
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: "#aaa",
          fontSize: 10,
          fontWeight: 600,
        }}
      >
        <Icon path={icons.clock} size={11} color="#aaa" />
        Ella confirms payments
      </div>
    </div>
  );
}

function DashboardRecentChargesList({ items = [], onOpenTarget, user }) {
  function targetKeyForExpense(e) {
    if (!e) return null;
    const isRecurring = e.recurring && e.recurring !== "none";
    if (isRecurring) {
      const gid = e.groupId || e.id;
      return gid ? `grp:${gid}` : null;
    }
    return e.id ? `exp:${e.id}` : null;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        maxHeight: 220,
        overflowY: "auto",
        paddingRight: 4,
        WebkitOverflowScrolling: "touch",
      }}
    >
      {items.map((e) => {
        const key = targetKeyForExpense(e);
        const due = e.nextDue || e.dueDate || null;
        const metaLeft = due ? `Due ${formatShortDate(due)}` : formatShortDate(e.date);
        const camAmt =
          e.split === "cam" ? Number(e.amount || 0) :
          e.split === "split" ? Number(e.amount || 0) / 2 :
          e.split === "ella" ? -Number(e.amount || 0) :
          0;
        const youAmt = camAmt;
        const youIsCredit = youAmt < 0;
        const dashUrgency = getUrgencyLevel(e);
        const dashStatusLabel =
          e.status === "paid"
            ? "Paid"
            : youIsCredit
              ? "Credit"
              : dashUrgency === "overdue"
                ? "Overdue"
                : "Unpaid";
        const dashStatusColor =
          e.status === "paid" || youIsCredit
            ? "#7BBFB0"
            : dashUrgency === "overdue"
              ? "#E05C6E"
              : "#C06A8A";
        const dashStatusWidth =
          e.status === "paid" || youIsCredit ? "100%" : dashUrgency === "overdue" ? "85%" : "55%";
        const dashStatusBg =
          e.status === "paid" || youIsCredit
            ? "#EEF5EC"
            : dashUrgency === "overdue"
              ? "#FFF0F0"
              : "#FBEFF5";

        return (
          <button
            key={e.id || `${e.description}-${e.date}`}
            type="button"
            onClick={() => {
              if (key && typeof onOpenTarget === "function") onOpenTarget(key);
            }}
            style={{
              width: "100%",
              background: "#fff",
              border: "1px solid #F0EAF8",
              borderRadius: 16,
              padding: "12px 14px",
              display: "flex",
              alignItems: "center",
              gap: 12,
              boxShadow: "0 2px 10px rgba(0,0,0,0.04)",
              cursor: "pointer",
              textAlign: "left",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: SPLIT_COLORS[e.split] || "#CCC",
                flexShrink: 0,
              }}
            />

            <div style={{ flex: 1, minWidth: 0 }}>
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  fontWeight: 800,
                  color: "#2D1B5E",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {e.description}
              </p>
              <p style={{ margin: "3px 0 0", fontSize: 11, color: "#999" }}>
  {user === "cam"
    ? `${e.account} · ${e.category}`
    : `${metaLeft} · ${e.account}`}
</p>
            </div>

            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "#2D1B5E" }}>
                ${Number(user === "cam" ? Math.abs(youAmt) : Number(e.amount || 0)).toFixed(2)}
              </p>
              {user === "emma" && camAmt !== 0 && (
                <p style={{ margin: "2px 0 0", fontSize: 11, fontWeight: 700, color: "#E8A0B0" }}>
                  Cam: ${Number(camAmt || 0).toFixed(2)}
                </p>
              )}

              {user === "cam" && (e.status === "paid" || youAmt !== 0) && (
                <>
                  <span
  style={{
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    padding: "3px 10px",
    borderRadius: 999,
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: 0.2,
    marginTop: 4,
    background: dashStatusBg,
    color:
      e.status === "paid" || youIsCredit
        ? "#1E8449"
        : dashUrgency === "overdue"
          ? "#E05C6E"
          : "#C06A8A",
  }}
>
  {dashUrgency === "overdue" && e.status !== "paid" && !youIsCredit && (
    <Icon path={icons.alert} size={10} color="#E05C6E" />
  )}
  {dashStatusLabel}
</span>

                  <div
                    style={{
                      width: 84,
                      height: 5,
                      borderRadius: 999,
                      background: "#F3EDF8",
                      marginLeft: "auto",
                      marginTop: 6,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: dashStatusWidth,
                        height: "100%",
                        background: dashStatusColor,
                        borderRadius: 999,
                      }}
                    />
                  </div>
                </>
              )}
            </div>

            <div style={{ marginLeft: 6, flexShrink: 0 }}>
              <Icon path={icons.forward} size={18} color="#C4A8D4" />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function DashboardActionChips({ onAddExpense, onLogPayment }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flexShrink: 0, width: 110 }}>
      <button
        type="button"
        onClick={onAddExpense}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          borderRadius: 18,
          cursor: "pointer",
          border: "none",
          padding: "14px 10px",
          boxShadow: "0 3px 12px rgba(30,15,69,0.13)",
          background: "linear-gradient(160deg, #7bbfb0, #4e9e90)",
        }}
      >
        <div
          style={{
            width: 34,
            height: 34,
            background: "rgba(255,255,255,0.22)",
            borderRadius: 11,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon path={icons.plus} size={18} color="#fff" />
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
            color: "#fff",
            textAlign: "center",
            lineHeight: 1.3,
            whiteSpace: "pre",
          }}
        >
          {"Add\nExpense"}
        </span>
      </button>

      <button
        type="button"
        onClick={onLogPayment}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          borderRadius: 18,
          cursor: "pointer",
          border: "none",
          padding: "14px 10px",
          boxShadow: "0 3px 12px rgba(30,15,69,0.13)",
          background: "linear-gradient(160deg, #c4a8d4, #9a72ba)",
        }}
      >
        <div
          style={{
            width: 34,
            height: 34,
            background: "rgba(255,255,255,0.22)",
            borderRadius: 11,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon path={icons.wallet} size={18} color="#fff" />
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
            color: "#fff",
            textAlign: "center",
            lineHeight: 1.3,
            whiteSpace: "pre",
          }}
        >
          {"Log\nPayment"}
        </span>
      </button>
    </div>
  );
}

// ── DASHBOARD ─────────────────────────────────────────────────────────
function DashboardScreen({ user, balance, totalOwed, totalPaid, expenses, payments, syncingPayments, urgentCount, targetSummaries, onOpenTarget, onAddExpense, onLogPayment, onConfirm, onDeleteExpense, onMarkPaid, onNavigate, onLogout }) {
  const pending = payments.filter((p) => !p.confirmed);
  // Cam dashboard urgent banner improvement: Step 3
  const urgentList = (expenses || []).filter((e) => getUrgencyLevel(e) !== null);
  const overdueCount = urgentList.filter((e) => getUrgencyLevel(e) === "overdue").length;
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchVal, setSearchVal] = useState("");
  const [balanceOpen, setBalanceOpen] = useState(false);

  const sortedByDate = (expenses || [])
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const q = String(searchVal || "").trim().toLowerCase();
  const filtered = q
    ? sortedByDate.filter((e) => {
        const d = String(e.description || "").toLowerCase();
        const c = String(e.category || "").toLowerCase();
        const a = String(e.account || "").toLowerCase();
        const amt = String(e.amount ?? "").toLowerCase();
        const due = String(e.nextDue || e.dueDate || "").toLowerCase();
        return d.includes(q) || c.includes(q) || a.includes(q) || amt.includes(q) || due.includes(q);
      })
    : sortedByDate;

  // Show 4 items normally, but show up to 10 matches when searching.
  const searchedRecent = (q ? filtered.slice(0, 10) : filtered.slice(0, 4));

  // Dashboard progress section: plans + one-time targets
  const allTargets = targetSummaries ? Array.from(targetSummaries.values()) : [];
  const planTargets = allTargets.filter((t) => t.key?.startsWith("grp:") && Number(t.charged || 0) !== 0);
  const oneTimeTargets = allTargets.filter((t) => t.key?.startsWith("exp:") && Number(t.remaining || 0) !== 0);

  planTargets.sort((a, b) => Number(b.remaining || 0) - Number(a.remaining || 0));
  oneTimeTargets.sort((a, b) => Number(b.remaining || 0) - Number(a.remaining || 0));

  // Monthly breakdown (simple): use nextDue/dueDate/date to bucket by current month
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const monthItems = (expenses || []).filter((e) => {
    const iso = e.nextDue || e.dueDate || e.date;
    if (!iso) return false;
    return String(iso).slice(0, 7) === monthKey;
  });

  const camOwesThisMonth = monthItems.reduce((s, e) => {
    const amt = Number(e.amount || 0);
    if (e.split === "cam") return s + amt;
    if (e.split === "split") return s + amt / 2;
    if (e.split === "ella") return s - amt; // Emmanuella pays reduces Cam's owed
    return s;
  }, 0);

  const emmaPaidThisMonth = monthItems.reduce((s, e) => {
    const amt = Number(e.amount || 0);
    if (e.split === "mine") return s + amt;
    if (e.split === "ella") return s + amt;
    if (e.split === "split") return s + amt / 2;
    return s;
  }, 0);

  // Cam's confirmed payments for the current month
  const camPaidThisMonth = (payments || [])
    .filter((p) => p?.confirmed)
    .filter((p) => String(p.date || "").slice(0, 7) === monthKey)
    .reduce((s, p) => s + Number(p.amount || 0), 0);

  return (
    <div style={styles.screen}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <p style={styles.headerGreet}>Hey {user === "emma" ? "Emmanuella" : "Cameron"} 👋</p>
          <p style={styles.headerSub}>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            style={{
              ...styles.logoutBtn,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: "6px 12px",
              minWidth: 40,
              height: 32,
              background: searchOpen ? "#2D1B5E" : "rgba(255,255,255,0.7)",
              color: searchOpen ? "#fff" : "#888",
            }}
            onClick={() => {
              setSearchOpen((o) => !o);
              setSearchVal("");
            }}
            aria-label={searchOpen ? "Close search" : "Search"}
            type="button"
          >
            {searchOpen ? (
              <Icon path={icons.x} size={18} color="#fff" />
            ) : (
              <Icon path={icons.search} size={18} color="#888" />
            )}
          </button>
          <button style={styles.logoutBtn} onClick={onLogout}>Switch</button>
        </div>
      </div>

      {searchOpen && (
        <div style={styles.searchBar}>
          <span style={styles.searchIcon}>
            <Icon path={icons.search} size={14} color="#AAA" />
          </span>
          <input
            autoFocus
            style={styles.searchInput}
            placeholder={user === "cam" ? "Search your charges…" : "Search recent charges…"}
            value={searchVal}
            onChange={(e) => setSearchVal(e.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Escape") {
                ev.preventDefault();
                setSearchOpen(false);
                setSearchVal("");
              }
            }}
          />
          {searchVal && (
            <button style={styles.clearSearch} onClick={() => setSearchVal("")} type="button">
              <Icon path={icons.x} size={14} color="#888" />
            </button>
          )}
        </div>
      )}

      {/* Balance Card */}
      <div
        style={{
          ...styles.balanceCard,
          cursor: "pointer",
          background:
            user === "cam"
              ? "linear-gradient(135deg, #7A1C3E, #E05C6E)"
              : styles.balanceCard.background,
          boxShadow:
            user === "cam"
              ? "0 12px 40px rgba(224,92,110,0.22)"
              : styles.balanceCard.boxShadow,
        }}
        onClick={() => setBalanceOpen((o) => !o)}
        role="button"
      >
        <p style={styles.balanceLabel}>{user === "cam" ? "You owe Emmanuella" : "Cameron owes you"}</p>
        <p style={styles.balanceAmount}>${balance.toFixed(2)}</p>
        <div style={styles.balanceRow}>
          <div style={styles.balanceStat}>
            <span style={styles.balanceStatLabel}>Total charged</span>
            <span style={styles.balanceStatVal}>${totalOwed.toFixed(2)}</span>
          </div>
          <div style={styles.balanceDivider} />
          <div style={styles.balanceStat}>
            <span style={styles.balanceStatLabel}>{user === "cam" ? "You've paid" : "Total paid"}</span>
            <span style={{ ...styles.balanceStatVal, color: "#A8EFC4" }}>
              ${totalPaid.toFixed(2)}
            </span>
          </div>
        </div>

        {balanceOpen && (
          <div style={styles.breakdownBox}>
            <p style={styles.breakdownTitle}>This month</p>
            <div style={styles.breakdownRow}>
              <span style={styles.breakdownDesc}>{user === "cam" ? "You owe this month" : "Cam owes this month"}</span>
              <span style={styles.breakdownAmt}>${Number(camOwesThisMonth || 0).toFixed(2)}</span>
            </div>
            <div style={styles.breakdownRow}>
              <span style={styles.breakdownDesc}>{user === "cam" ? "Paid this month" : "Your expenses this month"}</span>
              <span style={{ ...styles.breakdownAmt, color: "#fff" }}>
                ${Number(user === "cam" ? camPaidThisMonth : emmaPaidThisMonth || 0).toFixed(2)}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Mockup actions (Emma): Pending + Actions if pending exists, else Actions only */}
      {user === "emma" && pending.length > 0 ? (
        <div style={{ display: "flex", gap: 12, padding: "0 16px", marginBottom: 16 }}>
          <DashboardPendingCard user={user} pendingPayments={pending} onConfirm={onConfirm} />
          <DashboardActionChips onAddExpense={onAddExpense} onLogPayment={onLogPayment} />
        </div>
      ) : user === "emma" ? (
        <div style={{ display: "flex", gap: 12, padding: "0 16px", marginBottom: 16 }}>
          <DashboardPendingCard user={user} pendingPayments={pending} onConfirm={onConfirm} />
          <DashboardActionChips onAddExpense={onAddExpense} onLogPayment={onLogPayment} />
        </div>
      ) : null}

      {/* Cam quick actions row */}
      {user === "cam" && (
        <div style={{ ...styles.section, paddingTop: 0, marginBottom: 10 }}>
          <div style={{ ...styles.sectionHeader, justifyContent: "space-between", paddingTop: 0 }}>
            <span style={styles.sectionTitle}>Quick actions</span>
            <span style={{ fontSize: 12, color: "#888", fontWeight: 700 }}>Tap to log</span>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
            <CamPendingCard pendingPayments={pending} onOpenHistory={() => onNavigate("history")} />
            <DashboardActionChips onAddExpense={onAddExpense} onLogPayment={onLogPayment} />
          </div>
        </div>
      )}

      <MonthlySummaryCard expenses={expenses} />
      <InsightsSection expenses={expenses} />

      {/* Progress */}
      {(planTargets.length > 0 || oneTimeTargets.length > 0) && (
        <div style={styles.section}>
          <div style={{ ...styles.sectionHeader, justifyContent: "space-between" }}>
            <span style={styles.sectionTitle}>Progress</span>
            <span style={{ fontSize: 12, color: "#888" }}>
              {user === "cam" ? "Your balances" : "All balances"}
            </span>
          </div>

          {planTargets.length > 0 && (
            <>
              <p style={styles.progressSubTitle}>Plans</p>
              {planTargets.map((p) => {
                const charged = Number(p.charged || 0);
                const paid = Number(p.paid || 0);
                const remaining = Number(p.remaining || 0);
                const pct = charged > 0 ? Math.max(0, Math.min(1, paid / charged)) : 0;

                return (
                  <div
                    key={p.key}
                    style={{ ...styles.planCard, cursor: "pointer" }}
                    onClick={() => onOpenTarget && onOpenTarget(p.key)}
                    role="button"
                  >
                    <div style={styles.planTopRow}>
                      <p style={styles.planTitle}>{p.label}</p>
                      <p style={styles.planRemaining}>${remaining.toFixed(2)} left</p>
                    </div>
                    <div style={styles.planMetaRow}>
                      <span style={styles.planMetaText}>Paid: ${paid.toFixed(2)}</span>
                      <span style={styles.planMetaText}>Total: ${charged.toFixed(2)}</span>
                    </div>
                    <div style={styles.progressTrack}>
                      <div style={{ ...styles.progressFill, width: `${pct * 100}%` }} />
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {oneTimeTargets.length > 0 && (
            <>
              <p style={styles.progressSubTitle}>One-time</p>
              {oneTimeTargets.slice(0, 6).map((t) => (
                <div
                  key={t.key}
                  style={{ ...styles.oneTimeRow, cursor: "pointer" }}
                  onClick={() => onOpenTarget && onOpenTarget(t.key)}
                  role="button"
                >
                  <span style={styles.oneTimeLabel}>{t.label}</span>
                  <span style={styles.oneTimeAmt}>${Number(t.remaining || 0).toFixed(2)} left</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Urgent banner */}
      {urgentCount > 0 && (
        <div
          style={{
            ...styles.urgentBanner,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
          onClick={() => onNavigate("urgent")}
          role="button"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 14,
                background: "rgba(224,92,110,0.12)",
                border: "1.5px solid #E8A0B0",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Icon path={icons.fire} size={18} color="#E05C6E" />
            </div>

            <div style={{ minWidth: 0 }}>
              <p style={styles.urgentBannerTitle}>
                {user === "cam" && overdueCount > 0
                  ? `${overdueCount} charge${overdueCount === 1 ? "" : "s"} overdue`
                  : user === "cam"
                    ? `${urgentCount} charge${urgentCount === 1 ? "" : "s"} due soon`
                    : `${urgentCount} payment${urgentCount === 1 ? "" : "s"} due soon`}
              </p>
              <p style={styles.urgentBannerSub}>
                {user === "cam" ? "Tap to review your charges" : "Tap to see what needs attention"}
              </p>
            </div>
          </div>

          <div style={{ flexShrink: 0 }}>
            <Icon path={icons.forward} size={20} color="#E05C6E" />
          </div>
        </div>
      )}

      {/* Pending Confirmations (Emma only) */}
      {user === "emma" && pending.length > 0 && false && (
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <Icon path={icons.alert} size={16} color="#E8C878" />
            <span style={styles.sectionTitle}>Cam logged a payment — confirm?</span>
          </div>
          {pending.map(p => (
            <div key={p.id} style={styles.pendingCard}>
              <div>
                <p style={styles.pendingAmt}>${p.amount.toFixed(2)}</p>
                <p style={styles.pendingMeta}>{p.method} · {p.date}{p.note ? ` · "${p.note}"` : ""}</p>
              </div>
              <button style={styles.confirmBtn} onClick={() => onConfirm(p.id)}>
                <Icon path={icons.check} size={14} color="#fff" /> Confirm
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Cam pending message */}
      {false && user === "cam" && pending.length > 0 && (
        <div
          role="button"
          tabIndex={0}
          onClick={() => onNavigate("history")}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              onNavigate("history");
            }
          }}
          style={{
            margin: "0 16px 16px",
            background: "#fff",
            borderRadius: 20,
            padding: 14,
            boxShadow: "0 4px 16px rgba(30,15,69,0.09)",
            border: "1.5px solid #ede4f5",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            cursor: "pointer",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 14,
                background: "#FBF5E0",
                border: "1.5px solid #E8C878",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Icon path={icons.clock} size={18} color="#C8A020" />
            </div>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "#2D1B5E" }}>
                Pending confirmation
              </p>
              <p style={{ margin: "3px 0 0", fontSize: 11, color: "#888" }}>
                ${pending.reduce((s, p) => s + Number(p.amount || 0), 0).toFixed(2)} waiting for Emmanuella
              </p>
            </div>
          </div>
          <div style={{ flexShrink: 0 }}>
            <Icon path={icons.forward} size={20} color="#E05C6E" />
          </div>
        </div>
      )}

      {/* Syncing indicator */}
      {syncingPayments && (
        <div style={{ ...styles.alertBox, background: "#EEF5EC", borderColor: "#A8C5A0" }}>
          <Icon path={icons.clock} size={16} color="#1E8449" />
          <p style={{ color: "#1A4A2E", fontSize: 13, margin: 0 }}>
            Syncing your latest payment…
          </p>
        </div>
      )}

      {/* Action Buttons */}
      {user !== "emma" && user !== "cam" && (
        <div style={styles.actionRow}>
          <button style={{...styles.actionBtn, background: "linear-gradient(135deg, #7BBFB0, #5CA89A)"}} onClick={onAddExpense}>
            <Icon path={icons.plus} size={18} color="#fff" />
            <span>Add Expense</span>
          </button>
          <button style={{
            ...styles.actionBtn,
            background: "linear-gradient(135deg, #C4A8D4, #A88CC0)",
          }} onClick={onLogPayment}>
            <Icon path={icons.wallet} size={18} color="#fff" />
            <span>{user === "cam" ? "Log My Payment" : "Record Payment"}</span>
          </button>
        </div>
      )}


      {/* Recent Expenses */}
      <div style={styles.section}>
        <div style={{...styles.sectionHeader, justifyContent: "space-between"}}>
          <span style={styles.sectionTitle}>{user === "cam" ? "Your charges" : "Recent charges"}</span>
          <button style={styles.seeAll} onClick={() => onNavigate("expenses")}>
            {user === "cam" ? "View all" : "See all"}
          </button>
        </div>
        <DashboardRecentChargesList items={searchedRecent} onOpenTarget={onOpenTarget} user={user} />
      </div>

      <div style={{height: 80}} />
    </div>
  );
}

// ── URGENT SCREEN ────────────────────────────────────────────────────
function UrgentScreen({ expenses, user, onBack, onMarkPaid }) {
  const sorted = [...expenses].sort(
    (a, b) => (getDaysUntilDue(a.nextDue || a.dueDate) ?? 999) - (getDaysUntilDue(b.nextDue || b.dueDate) ?? 999)
  );

  return (
    <div style={styles.screen}>
      <div style={styles.subHeader}>
        <button
          type="button"
          style={{
            ...styles.logoutBtn,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "6px 12px",
            minWidth: 40,
            height: 32,
            background: "rgba(255,255,255,0.7)",
            color: "#2D1B5E",
          }}
          onClick={onBack}
          aria-label="Back"
        >
          <Icon path={icons.back} size={18} />
        </button>

        <h2 style={{ ...styles.subTitle, flex: 1, textAlign: "center", minWidth: 0 }}>Urgent</h2>

        <div style={{ minWidth: 40, height: 32 }} />
      </div>

      <div style={{ padding: "0 16px 8px", fontSize: 12, color: "#888" }}>
        Entries with a due date that are overdue or coming up soon
      </div>

      <div style={{ padding: "0 16px" }}>
        {sorted.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <p style={{ fontSize: 48, margin: 0 }}>✅</p>
            <p style={{ fontWeight: 700, color: "#2D1B5E", fontSize: 18, margin: "12px 0 4px" }}>
              All clear!
            </p>
            <p style={{ color: "#999", fontSize: 13, margin: 0 }}>No overdue or upcoming payments</p>
          </div>
        ) : (
          sorted.map((e) => {
            const level = getUrgencyLevel(e);
            const u = URGENCY[level];
            const days = getDaysUntilDue(e.nextDue || e.dueDate);

            const dueLabel =
              days < 0
                ? `${Math.abs(days)} day${Math.abs(days) !== 1 ? "s" : ""} overdue`
                : days === 0
                ? "Due TODAY"
                : days === 1
                ? "Due TOMORROW"
                : `Due in ${days} days`;

            const camAmt = e.split === "cam" ? e.amount : e.split === "split" ? e.amount / 2 : 0;

            return (
              <div
                key={e.id}
                style={{
                  background: u.bg,
                  border: `1.5px solid ${u.border}`,
                  borderRadius: 16,
                  padding: "16px",
                  marginBottom: 10,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <span
                        style={{
                          background: u.badge,
                          color: "#fff",
                          borderRadius: 6,
                          padding: "2px 8px",
                          fontSize: 10,
                          fontWeight: 800,
                          letterSpacing: 0.5,
                        }}
                      >
                        {u.label}
                      </span>
                      <span style={{ fontSize: 11, color: u.badge, fontWeight: 700 }}>{dueLabel}</span>
                    </div>
                    <p style={{ fontSize: 14, fontWeight: 700, color: "#2D1B5E", margin: "0 0 2px" }}>
                      {e.description}
                    </p>
                    <p style={{ fontSize: 11, color: "#888", margin: 0 }}>
                      {e.account} · {e.category}
                    </p>
                    <p style={{ fontSize: 11, color: u.badge, fontWeight: 600, margin: "2px 0 0" }}>
                      Due: {formatShortDate(e.nextDue || e.dueDate)}
                    </p>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <p style={{ fontSize: 18, fontWeight: 800, color: "#2D1B5E", margin: 0 }}>
                      ${Number(e.amount || 0).toFixed(2)}
                    </p>
                    {camAmt > 0 && (
                      <p style={{ fontSize: 12, color: "#E8A0B0", fontWeight: 700, margin: "2px 0 0" }}>
                        Cam owes: ${camAmt.toFixed(2)}
                      </p>
                    )}
                    {user === "emma" && !e._optimistic && (
  <button style={styles.markPaidBtn} onClick={() => onMarkPaid(e.id)}>
    Mark paid
  </button>
)}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div style={{ height: 80 }} />
    </div>
  );
}


// ---- Expenses screen ----
// Sticky Dynamic Island = Header + (Cam Summary Pill) + Search + Filters (All / Unpaid / Paid)
function ExpensesScreen({
  expenses,
  payments,
  user,
  onBack,
  onDeleteExpense,
  onMarkPaid,
  targetSummaries,
  onLogPaymentForKey,
}) {
  const isCam = user === "cam";
  const screenRef = useRef(null);

  // ★ CHANGE 2: Added "installments" to the filter options
  const [statusFilter, setStatusFilter] = useState("all"); // all | unpaid | paid | installments
  const [searchOpen, setSearchOpen] = useState(false);

  // ---- CAM SUMMARY CARD DATA (for maroon pill) ----
  const allCamCharges = isCam
    ? (expenses || []).filter((e) => ["cam", "split", "ella"].includes(e.split))
    : [];

  const camChargeSummary = allCamCharges.reduce(
    (acc, e) => {
      const camShare =
        e.split === "cam"
          ? Number(e.amount || 0)
          : e.split === "split"
          ? Number(e.amount || 0) / 2
          : e.split === "ella"
          ? -Number(e.amount || 0)
          : 0;

      const fallbackTotal = Math.abs(camShare);
      const itemPaid = Number(e.paid ?? (e.status === "paid" ? fallbackTotal : 0));
      const remaining = Math.max(fallbackTotal - itemPaid, 0);
      const isOverdue = e.overdue === true || getUrgencyLevel(e) === "overdue";

      acc.totalOwed += remaining;
      acc.totalPaid += itemPaid;
      if (isOverdue) acc.overdueCount += 1;
      return acc;
    },
    { totalOwed: 0, totalPaid: 0, overdueCount: 0 }
  );

  const progressBase = camChargeSummary.totalPaid + camChargeSummary.totalOwed;
  const camChargePct =
    progressBase > 0 ? Math.round((camChargeSummary.totalPaid / progressBase) * 100) : 0;

  // ★ CHANGE 2: Updated matchesStatusFilter to handle "installments"
  function matchesStatusFilter(e) {
    const isPaid = e?.status === "paid";
    const isCredit = e?.split === "ella";
    const isRecurring = e?.recurring && e.recurring !== "none";

    if (statusFilter === "paid") return isPaid;
    if (statusFilter === "unpaid") return !isPaid && !isCredit;
    if (statusFilter === "installments") return isRecurring;
    return true; // all
  }

  // ---- Base list (role + status filter) ----
  const baseList = (() => {
    const list = expenses || [];
    if (isCam) return list.filter((e) => ["cam", "split", "ella"].includes(e.split));
    return list;
  })();

  const baseFiltered = baseList.filter(matchesStatusFilter);

  // ---- Confirmed payments (shown under "Paid" filter) ----
  const confirmedPayments = statusFilter === "paid"
    ? (payments || []).filter((p) => p && p.confirmed).map((p) => ({ ...p, _isPayment: true }))
    : [];

  const combinedFiltered = statusFilter === "paid"
    ? [...baseFiltered.map((e) => ({ ...e, _isPayment: false })), ...confirmedPayments]
        .sort((a, b) => new Date(b.date) - new Date(a.date))
    : baseFiltered;

  // ---- Search logic ----
  const search = useExpensesSearchLogic(baseFiltered);
  const listToRender = searchOpen ? search.filteredExpenses : combinedFiltered;

  // Keep the UI toggle in sync with the hook
  useEffect(() => {
    if (searchOpen && !search.searchActive) search.activateSearch();
    if (!searchOpen && search.searchActive) search.cancelSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen]);

  useEffect(() => {
    if (search.searchActive && screenRef.current) {
      screenRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [search.searchActive]);

  // ---- Inline island styles (self-contained, avoids missing styles.* keys) ----
  const island = {
    sticky: {
      position: "sticky",
      top: 0,
      zIndex: 30,
      padding: "48px 16px 12px",
      background: "linear-gradient(160deg, rgba(248,244,255,0.98), rgba(248,244,255,0.90))",
      backdropFilter: "blur(10px)",
    },
    card: {
      background: "rgba(255,255,255,0.85)",
      border: "1px solid #F0EAF8",
      borderRadius: 22,
      boxShadow: "0 8px 30px rgba(45,27,94,0.10)",
      overflow: "hidden",
    },
    headerRow: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "10px 12px",
      gap: 10,
    },
    iconBtn: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      padding: "6px 12px",
      minWidth: 40,
      height: 32,
      borderRadius: 12,
      border: "none",
      background: "rgba(255,255,255,0.7)",
      color: "#2D1B5E",
      cursor: "pointer",
    },
    title: {
      flex: 1,
      minWidth: 0,
      textAlign: "center",
      fontSize: 16,
      fontWeight: 900,
      color: isCam ? "#7A1C3E" : "#2D1B5E",
      margin: 0,
    },
    rightRow: { display: "flex", gap: 8, alignItems: "center", flexShrink: 0 },
    searchBtn: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      padding: "6px 12px",
      minWidth: 40,
      height: 32,
      borderRadius: 12,
      border: "none",
      background: search.searchActive ? (isCam ? "#E05C6E" : "#2D1B5E") : "rgba(255,255,255,0.7)",
      color: search.searchActive ? "#fff" : isCam ? "#E05C6E" : "#2D1B5E",
      cursor: "pointer",
    },
    addBtn: {
      width: 40,
      height: 34,
      borderRadius: 16,
      border: "none",
      background: "linear-gradient(135deg, #7BBFB0, #5CA89A)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
    },
    pillWrap: { padding: "0 12px 12px" },
    maroonPill: {
      background: "linear-gradient(135deg, #3a0f1a, #802040)",
      borderRadius: 22,
      padding: "14px 16px",
      color: "#fff",
      boxShadow: "0 10px 30px rgba(80,15,30,0.25)",
    },
    filterRow: { display: "flex", gap: 8, overflowX: "auto", padding: "10px 12px 12px" },
    chip: {
      flexShrink: 0,
      padding: "6px 14px",
      borderRadius: 999,
      border: "1.5px solid #E5DFF5",
      background: "#fff",
      fontSize: 13,
      fontWeight: 800,
      color: "#888",
      cursor: "pointer",
      whiteSpace: "nowrap",
    },
    chipActive: {
      background: isCam ? "#FFF0F0" : "#2D1B5E",
      color: isCam ? "#E05C6E" : "#fff",
      borderColor: isCam ? "#E8A0B0" : "#2D1B5E",
    },
    searchRow: { padding: "10px 12px 12px" },
    searchFieldWrap: { position: "relative", display: "flex", alignItems: "center" },
    searchIcon: { position: "absolute", left: 12, display: "flex", alignItems: "center", justifyContent: "center" },
    searchInput: {
      width: "100%",
      padding: "10px 36px 10px 34px",
      borderRadius: 12,
      border: "1.5px solid #E5DFF5",
      background: "#fff",
      fontSize: 15,
      color: "#2D1B5E",
      outline: "none",
    },
    searchClearBtn: {
      position: "absolute",
      right: 10,
      width: 20,
      height: 20,
      borderRadius: 10,
      border: "none",
      cursor: "pointer",
      background: "#CCC",
      color: "#fff",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    },
  };

  return (
    <div ref={screenRef} style={styles.screen}>
      {/* Sticky Dynamic Island */}
      <div style={island.sticky}>
        <div style={island.card}>
          {/* Header */}
          <div style={island.headerRow}>
            <button
              type="button"
              style={island.iconBtn}
              onClick={() => {
                if (search.searchActive) {
                  setSearchOpen(false);
                  search.cancelSearch();
                  return;
                }
                if (typeof onBack === "function") onBack();
              }}
              aria-label="Back"
            >
              <Icon path={icons.back} size={18} color={isCam ? "#7A1C3E" : "#2D1B5E"} />
            </button>

            <h2 style={island.title}>{isCam ? "My charges" : "All Expenses"}</h2>

            <div style={island.rightRow}>
              <button
                type="button"
                style={island.searchBtn}
                onClick={() => setSearchOpen((v) => !v)}
                aria-label={search.searchActive ? "Close search" : "Search"}
              >
                {search.searchActive ? (
                  <Icon path={icons.x} size={18} color="#fff" />
                ) : (
                  <Icon path={icons.search} size={18} color={isCam ? "#E05C6E" : "#2D1B5E"} />
                )}
              </button>

              {!isCam && (
                <button
                  type="button"
                  style={island.addBtn}
                  onClick={() => (typeof onAddExpense === "function" ? onAddExpense() : null)}
                  aria-label="Add expense"
                >
                  <Icon path={icons.plusCircle} size={18} color="#fff" />
                </button>
              )}
            </div>
          </div>

          {/* Cam maroon summary pill */}
          {isCam && (
            <div style={island.pillWrap}>
              <div style={island.maroonPill}>
                <div style={{ display: "flex", alignItems: "stretch" }}>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 10, opacity: 0.55 }}>Still owe</span>
                    <span style={{ fontSize: 18, fontWeight: 900, letterSpacing: -0.5, color: "#ffb3b3" }}>
                      ${camChargeSummary.totalOwed.toFixed(2)}
                    </span>
                  </div>

                  <div style={{ width: 1, background: "rgba(255,255,255,0.15)", margin: "0 12px" }} />

                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 10, opacity: 0.55 }}>Paid so far</span>
                    <span style={{ fontSize: 18, fontWeight: 900, letterSpacing: -0.5, color: "#a8efc4" }}>
                      ${camChargeSummary.totalPaid.toFixed(2)}
                    </span>
                  </div>

                  <div style={{ width: 1, background: "rgba(255,255,255,0.15)", margin: "0 12px" }} />

                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 10, opacity: 0.55 }}>Overdue</span>
                    <span
                      style={{
                        fontSize: 18,
                        fontWeight: 900,
                        letterSpacing: -0.5,
                        color: camChargeSummary.overdueCount > 0 ? "#ffb3b3" : "#a8efc4",
                      }}
                    >
                      {camChargeSummary.overdueCount}
                    </span>
                  </div>
                </div>

                <div style={{ marginTop: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,0.55)" }}>Overall progress</span>
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,0.85)", fontWeight: 800 }}>
                      {camChargePct}% cleared
                    </span>
                  </div>

                  <div style={{ background: "rgba(255,255,255,0.15)", borderRadius: 6, height: 7, overflow: "hidden" }}>
                    <div
                      style={{
                        height: "100%",
                        borderRadius: 6,
                        background: "#a8efc4",
                        width: `${camChargePct}%`,
                        transition: "width 0.4s",
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ★ CHANGE 3: Cam gets "Plans" chip, Emma doesn't */}
          {!search.searchActive && (
            <div style={island.filterRow}>
              {(isCam
                ? [["all","All"],["unpaid","Unpaid"],["installments","Plans"],["paid","Paid"]]
                : [["all","All"],["unpaid","Unpaid"],["paid","Paid"]]
              ).map(([val, label]) => {
                const active = statusFilter === val;
                return (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setStatusFilter(val)}
                    style={{ ...island.chip, ...(active ? island.chipActive : {}) }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Search input (when active) */}
          {search.searchActive && (
            <div style={island.searchRow}>
              <div style={island.searchFieldWrap}>
                <span style={island.searchIcon}>
                  <Icon path={icons.search} size={14} color="#AAA" />
                </span>
                <input
                  style={island.searchInput}
                  placeholder={isCam ? "Search your charges…" : "Search expenses…"}
                  value={search.searchQuery}
                  onChange={(e) => search.handleSearch(e.target.value)}
                  autoFocus
                  onKeyDown={(ev) => {
                    if (ev.key === "Escape") {
                      ev.preventDefault();
                      setSearchOpen(false);
                      search.cancelSearch();
                    }
                  }}
                />
                {search.searchQuery.length > 0 && (
                  <button type="button" style={island.searchClearBtn} onClick={search.clearSearch} aria-label="Clear search">
                    <Icon path={icons.x} size={14} color="#fff" />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Results */}
      {search.searchActive && search.searchQuery.length > 0 && listToRender.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px" }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>
            <Icon path={icons.search} size={48} color="#C4A8D4" />
          </div>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 900, color: "#2D1B5E" }}>No results found</p>
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "#888" }}>
            {isCam ? `No charges match "${search.searchQuery}"` : `No expenses match "${search.searchQuery}"`}
          </p>
        </div>
      ) : (
        <div style={{ padding: "0 16px" }}>
          {listToRender.map((e) => e._isPayment ? (
            <div key={e.id} style={{ ...styles.historyItem, margin: "0 0 2px", borderRadius: 14, background: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.05)", borderBottom: "none" }}>
              <div style={{ ...styles.historyIcon, background: "#EEF5EC" }}>
                <Icon path={icons.wallet} size={18} color="#1E8449" />
              </div>
              <div style={styles.historyInfo}>
                <p style={styles.historyDesc}>Payment via {e.method}{e.appliedToKey && e.appliedToKey !== "general" ? ` · toward ${e.appliedToKey}` : ""}</p>
                <p style={styles.historyMeta}>{formatHistoryDate(e.date)} <span style={styles.confirmedBadge}>confirmed</span></p>
                {e.note && <p style={styles.historyNote}>"{e.note}"</p>}
              </div>
              <div style={styles.historyAmt}>
                <p style={{ ...styles.historyAmtText, color: "#1E8449" }}>-${Number(e.amount || 0).toFixed(2)}</p>
              </div>
            </div>
          ) : (
            <ExpenseRow
              key={e.id}
              expense={e}
              user={user}
              onDelete={onDeleteExpense}
              onMarkPaid={onMarkPaid}
              targetSummaries={targetSummaries}
              onLogPaymentForKey={onLogPaymentForKey}
            />
          ))}
        </div>
      )}

      <div style={{ height: 80 }} />
    </div>
  );
}

// ── HISTORY SCREEN ────────────────────────────────────────────────────
function HistoryScreen({ expenses, payments, user, targets = [], onBack, onConfirm, onDeleteConfirmedPayment, onDeleteExpense }) {
  const all = [
    ...payments.map((p) => ({ ...p, type: "payment" })),
    ...expenses.flatMap((e) => {
      // Show ONE history row per expense.
      // If it has a paid timestamp, show it as a paid event with that timestamp.
      if (e.lastPaidAt) {
        return [
          {
            ...e,
            type: "expense",
            status: "paid",
            date: e.lastPaidAt,
            _paidEvent: true,
          },
        ];
      }
      return [{ ...e, type: "expense" }];
    }),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  const targetLabelByKey = new Map(
    (targets || []).map((t) => [t.key, t.label])
  );

  function paymentTargetLabel(p) {
    const key = p.appliedToKey || (p.appliedToGroupId ? `grp:${p.appliedToGroupId}` : "general");
    if (!key || key === "general") return null;
    return targetLabelByKey.get(key) || null;
  }

  return (
    <div style={styles.screen}>
      <div style={styles.subHeader}>
        <button
          type="button"
          style={{
            ...styles.logoutBtn,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "6px 12px",
            minWidth: 40,
            height: 32,
            background: "rgba(255,255,255,0.7)",
            color: "#2D1B5E",
          }}
          onClick={onBack}
          aria-label="Back"
        >
          <Icon path={icons.back} size={18} />
        </button>

        <h2 style={{ ...styles.subTitle, flex: 1, textAlign: "center", minWidth: 0 }}>History</h2>

        <div style={{ minWidth: 40, height: 32 }} />
      </div>

      {/* Step 5: Add PaymentTimeline framework component */}
      <PaymentTimeline payments={payments} targets={targets} />

      {all.map((item, i) => (
        <div key={i} style={styles.historyItem}>
          <div style={{
            ...styles.historyIcon,
            background: item.type === "payment" ? "#EEF5EC" : "#EDE4F5"
          }}>
            {item.type === "payment" ? (
              <Icon path={icons.wallet} size={18} color="#1E8449" />
            ) : (
              <Icon path={icons.list} size={18} color="#5B3B8C" />
            )}
          </div>
          <div style={styles.historyInfo}>
            <p style={styles.historyDesc}>
              {item.type === "payment"
                ? (() => {
                    const lbl = paymentTargetLabel(item);
                    return lbl ? `Payment via ${item.method} · toward ${lbl}` : `Payment via ${item.method}`;
                  })()
                : item.description}
            </p>
            <p style={styles.historyMeta}>
              {formatHistoryDate(item.date)} {item.type === "payment" && !item.confirmed && <span style={styles.pendingBadge}>pending</span>}
              {item.type === "payment" && item.confirmed && <span style={styles.confirmedBadge}>confirmed</span>}
              {item.type === "expense" && item.status === "paid" && <span style={styles.confirmedBadge}>paid</span>}
            </p>
            {item.note && <p style={styles.historyNote}>"{item.note}"</p>}
          </div>
          <div style={styles.historyAmt}>
            <p style={{
              ...styles.historyAmtText,
              color: item.type === "payment" ? "#1E8449" : item.split === "mine" ? "#555" : "#9E4C6A"
            }}>
              {item.type === "payment" ? "-" : ""}${(item.type === "payment" ? item.amount : item.split === "split" ? item.amount/2 : item.amount).toFixed(2)}
            </p>
            {item.type === "payment" && !item.confirmed && user === "emma" && (
              <button style={styles.miniConfirm} onClick={() => onConfirm(item.id)}>Confirm</button>
            )}
          </div>
          {item.type === "payment" && item.confirmed && user === "emma" && (
            <button
              style={styles.deleteBtn}
              onClick={() => onDeleteConfirmedPayment(item.id)}
              title="Delete confirmed payment"
            >
              <Icon path={icons.x} size={16} color="#C0485A" />
            </button>
          )}
          {item.type === "expense" && item.status === "paid" && user === "emma" && typeof onDeleteExpense === "function" && (
            <button
              style={styles.deleteBtn}
              onClick={() => onDeleteExpense(item.id)}
              title="Delete paid expense"
            >
              <Icon path={icons.x} size={16} color="#C0485A" />
            </button>
          )}
        </div>
      ))}
      <div style={{height: 80}} />
    </div>
  );
}


// ── EXPENSE ROW ───────────────────────────────────────────────────────
function ExpenseRow({ expense, user, onDelete, onMarkPaid, targetSummaries, onLogPaymentForKey }) {
  return (
    <ExpandableExpenseRow
      expense={expense}
      user={user}
      onDelete={onDelete}
      onMarkPaid={onMarkPaid}
      targetSummaries={targetSummaries}
      onLogPaymentForKey={onLogPaymentForKey}
    />
  );
}


// ── SPLITTRACK FRAMEWORK COMPONENTS (imported) ───────────────────────

function ExpandableExpenseRow({ expense: e, user, onDelete, onMarkPaid, targetSummaries, onLogPaymentForKey }) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState(e.note || "");
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(e.note || "");
  const [noteSaveStatus, setNoteSaveStatus] = useState(null); // null | "saving" | "saved" | "error"
  const noteSaveTimerRef = useRef(null);
  const [noteSaveFading, setNoteSaveFading] = useState(false);
  const noteFadeTimerRef = useRef(null);
  const [markPaidBusy, setMarkPaidBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    return () => {
      if (noteSaveTimerRef.current) clearTimeout(noteSaveTimerRef.current);
      if (noteFadeTimerRef.current) clearTimeout(noteFadeTimerRef.current);
    };
  }, []);

  const isCam = user === "cam";
  const camShare =
    e.split === "cam" ? Number(e.amount || 0) :
    e.split === "split" ? Number(e.amount || 0) / 2 :
    e.split === "ella" ? -Number(e.amount || 0) :
    0;
  const camIsCredit = camShare < 0;

  const urgency = getUrgencyLevel(e);
  const camStatusLabel =
    e.status === "paid"
      ? "Paid"
      : camIsCredit
        ? "Credit"
        : urgency === "overdue"
          ? "Overdue"
          : "Unpaid";

  const camStatusColor =
    e.status === "paid"
      ? "#7BBFB0"
      : camIsCredit
        ? "#7BBFB0"
        : urgency === "overdue"
          ? "#E05C6E"
          : "#E8A0B0";

  const camAmt =
    e.split === "cam" ? Number(e.amount || 0) :
    e.split === "split" ? Number(e.amount || 0) / 2 :
    e.split === "ella" ? -Number(e.amount || 0) :
    0;

  async function handleSaveNote(nextVal) {
    if (noteSaveTimerRef.current) clearTimeout(noteSaveTimerRef.current);
    if (noteFadeTimerRef.current) clearTimeout(noteFadeTimerRef.current);
    setNoteSaveFading(false);

    setNoteSaveStatus("saving");
    setEditingNote(false);
    setNote(nextVal);

    try {
      await updateExpenseInDb(e.id, { note: nextVal });
      setNoteSaveStatus("saved");
      setNoteSaveFading(false);

      noteFadeTimerRef.current = setTimeout(() => {
        setNoteSaveFading(true);
        noteFadeTimerRef.current = null;
      }, 1100);

      noteSaveTimerRef.current = setTimeout(() => {
        setNoteSaveStatus(null);
        setNoteSaveFading(false);
        noteSaveTimerRef.current = null;
      }, 1500);
    } catch (err) {
      console.error("Failed to save note:", err);
      setNote(e.note || "");
      setNoteDraft(e.note || "");
      setNoteSaveStatus("error");
      setNoteSaveFading(false);

      noteSaveTimerRef.current = setTimeout(() => {
        setNoteSaveStatus(null);
        noteSaveTimerRef.current = null;
      }, 2000);
    }
  }

  return (
    <div
      style={{
        ...fw.expenseCard,
        opacity: e._deleting ? 0.55 : e._marking ? 0.75 : 1,
        pointerEvents: e._deleting || e._marking ? "none" : "auto",
        border: isCam ? "1.5px solid #F0EAF8" : fw.expenseCard.border,
        boxShadow: isCam ? "0 2px 10px rgba(0,0,0,0.04)" : fw.expenseCard.boxShadow,
      }}
    >
      <div
        style={fw.expenseTop}
        onClick={() => {
          if (e._deleting || e._marking) return;
          setExpanded((o) => !o);
        }}
        role="button"
      >
        <div style={{ ...fw.splitDot, background: SPLIT_COLORS[e.split] }} />

        <div style={fw.expenseInfo}>
          <p style={fw.expenseDesc}>{e.description}</p>
          <p style={fw.expenseMeta}>
            {isCam
              ? `${e.account} · ${e.category}`
              : `${formatShortDate(e.date)} · ${e.account}`}
          </p>
          {isCam && (
            <div
              style={{
                width: "100%",
                height: 6,
                borderRadius: 999,
                background: "#F3EDF8",
                marginTop: 8,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: e.status === "paid" ? "100%" : camIsCredit ? "100%" : "55%",
                  height: "100%",
                  background: camStatusColor,
                  borderRadius: 999,
                }}
              />
            </div>
          )}
        </div>

        <div style={{ ...fw.expenseRight, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <p style={fw.expenseTotal}>
            ${Number(isCam ? Math.abs(camShare) : Number(e.amount || 0)).toFixed(2)}
          </p>

          {!isCam && camAmt !== 0 && (
            <p style={fw.expenseCam}>Cam: ${Number(camAmt || 0).toFixed(2)}</p>
          )}

          {isCam && (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      alignSelf: "flex-end",
      gap: 4,
      padding: "3px 10px",
      borderRadius: 999,
      fontSize: 10,
      fontWeight: 800,
      letterSpacing: 0.2,
      background:
        camStatusLabel === "Paid" || camStatusLabel === "Credit"
          ? "#EEF5EC"
          : camStatusLabel === "Overdue"
            ? "#FFF0F0"
            : "#FBEFF5",
      color:
        camStatusLabel === "Paid" || camStatusLabel === "Credit"
          ? "#1E8449"
          : camStatusLabel === "Overdue"
            ? "#E05C6E"
            : "#C06A8A",
      marginTop: 2,
    }}
  >
    {camStatusLabel === "Overdue" && <Icon path={icons.alert} size={10} color="#E05C6E" />}
    {camStatusLabel}
  </span>
)}

          <div style={fw.chevron}>
            <Icon
              path={expanded ? icons.chevronUp : icons.chevronDown}
              size={16}
              color={expanded ? "#2D1B5E" : "#CCC"}
            />
          </div>
        </div>
      </div>

      {expanded && (
        <div style={fw.expandPanel} onClick={(ev) => ev.stopPropagation()}>
          

          {/* ★ CHANGE 1: Payment plan containers wired to real targetSummaries data */}
          {isCam && (() => {
            const isRecurring = e.recurring && e.recurring !== "none";
            const targetKey = isRecurring ? `grp:${e.groupId || e.id}` : `exp:${e.id}`;
            const s = targetSummaries?.get(targetKey);
            const tCharged = Number(s?.charged || Math.abs(camShare));
            const tPaid = Number(s?.paid || 0);
            const tRemaining = Number(s?.remaining ?? (tCharged - tPaid));
            const suggested = Number(s?.suggested || Math.abs(camShare));
            const perOcc = Math.abs(camShare) || 1;
            const totalOcc = isRecurring && perOcc > 0 ? Math.max(1, Math.round(Math.abs(tCharged) / perOcc)) : null;
            const paidOcc = isRecurring && perOcc > 0 ? Math.min(totalOcc, Math.round(Math.abs(tPaid) / perOcc)) : null;
            const nextDue = e.nextDue || e.dueDate || null;

            return (
              <>
                {isRecurring && totalOcc !== null && (
                  <div style={fw.payPlanCard}>
                    <div style={fw.payPlanTop}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <div style={fw.payPlanPill}>Payment plan</div>
                        <div style={fw.payPlanStepText}>{paidOcc} of {totalOcc} payment{totalOcc !== 1 ? "s" : ""}</div>
                      </div>

                      <div style={fw.payPlanCircles} aria-label="Installment progress">
                        {Array.from({ length: Math.min(totalOcc, 8) }).map((_, i) => {
                          const done = i < paidOcc;
                          return (
                            <div
                              key={i}
                              style={{
                                ...fw.payPlanCircle,
                                ...(done ? fw.payPlanCircleDone : {}),
                              }}
                            >
                              {done && <Icon path={icons.check} size={8} color="#fff" />}
                            </div>
                          );
                        })}
                        {totalOcc > 8 && <span style={{ fontSize: 9, color: "#AAA", marginLeft: 2 }}>+{totalOcc - 8}</span>}
                      </div>
                    </div>

                    <div style={fw.payPlanBarTrack}>
                      <div style={{ ...fw.payPlanBarFill, width: `${totalOcc > 0 ? Math.round((paidOcc / totalOcc) * 100) : 0}%` }} />
                    </div>

                    {nextDue && (
                      <div style={fw.payPlanNextRow}>
                        <div style={{ minWidth: 0 }}>
                          <div style={fw.payPlanNextLabel}>Next payment</div>
                          <div style={fw.payPlanNextSub}>Due {formatShortDate(nextDue)}</div>
                        </div>

                        <div style={fw.payPlanNextRight}>
                          <div style={fw.payPlanNextAmt}>${Number(suggested).toFixed(2)}</div>
                          <div style={fw.payPlanNextDate}>{formatShortDate(nextDue)}</div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div style={fw.payMetaCard}>
                  <div style={fw.payMetaRow}>
                    <div style={fw.payMetaStat}>
                      <div style={fw.payMetaLabel}>Paid</div>
                      <div style={{ ...fw.payMetaVal, color: "#1E8449" }}>${Math.abs(tPaid).toFixed(2)}</div>
                    </div>

                    <div style={fw.payMetaDivider} />

                    <div style={fw.payMetaStat}>
                      <div style={fw.payMetaLabel}>Remaining</div>
                      <div style={{ ...fw.payMetaVal, color: tRemaining > 0.005 ? "#E05C6E" : "#1E8449" }}>${Math.max(0, tRemaining).toFixed(2)}</div>
                    </div>

                    <div style={fw.payMetaDivider} />

                    <div style={fw.payMetaStat}>
                      <div style={fw.payMetaLabel}>Total</div>
                      <div style={fw.payMetaVal}>${Math.abs(tCharged).toFixed(2)}</div>
                    </div>
                  </div>

                  {tRemaining > 0.005 ? (
                    <button type="button" style={fw.logPayBtn} onClick={() => typeof onLogPaymentForKey === "function" && onLogPaymentForKey(targetKey)}>
                      Log a payment
                    </button>
                  ) : (
  <div
    style={{
      ...fw.logPayBtn,
      background: "#EEF5EC",
      color: "#1E8449",
      cursor: "default",
      height: 40,
      padding: "0 12px",
      borderRadius: 12,
    }}
  >
    ✓ Fully paid
  </div>
)}
                </div>
              </>
            );
          })()}

          <div style={{ marginTop: 8 }}>
            <span style={fw.detailLabel}>Note</span>

            {editingNote ? (
              <div style={{ marginTop: 4 }}>
                <textarea
                  style={fw.noteTextarea}
                  value={noteDraft}
                  onChange={(ev) => setNoteDraft(ev.target.value)}
                  placeholder="Add a note…"
                  rows={3}
                  autoFocus
                  onKeyDown={(ev) => {
                    const isSave = (ev.ctrlKey || ev.metaKey) && ev.key === "Enter";
                    if (isSave) {
                      ev.preventDefault();
                      const trimmed = String(noteDraft || "");
                      handleSaveNote(trimmed);
                    }
                  }}
                />

                <div style={fw.noteBtnRow}>
                  <button
                    style={fw.noteCancelBtn}
                    type="button"
                    onClick={() => {
                      setEditingNote(false);
                      setNoteDraft(note);
                    }}
                  >
                    Cancel
                  </button>

                  <button
                    style={fw.noteSaveBtn}
                    type="button"
                    onClick={() => handleSaveNote(String(noteDraft || ""))}
                  >
                    Save
                  </button>
                </div>

                {noteSaveStatus && (
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      fontWeight: 700,
                      color:
                        noteSaveStatus === "saved"
                          ? "#1E8449"
                          : noteSaveStatus === "error"
                            ? "#E05C6E"
                            : "#888",
                      opacity: noteSaveStatus === "saved" ? (noteSaveFading ? 0 : 1) : 1,
                      transition: "opacity 300ms ease",
                    }}
                  >
                    {noteSaveStatus === "saving"
                      ? "Saving…"
                      : noteSaveStatus === "saved"
                        ? "Saved ✓"
                        : "Couldn't save"}
                  </div>
                )}
              </div>
            ) : (
              <>
                <p
                  style={fw.noteTap}
                  onClick={() => {
                    setNoteDraft(note);
                    setEditingNote(true);
                  }}
                >
                  {note || "Tap to add a note…"}
                </p>

                {noteSaveStatus === "saved" && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#1E8449",
                      opacity: noteSaveFading ? 0 : 1,
                      transition: "opacity 300ms ease",
                    }}
                  >
                    Saved ✓
                  </div>
                )}
              </>
            )}
          </div>

          {!isCam && user === "emma" && (
            <div style={fw.actionBtns}>
              {(markPaidBusy || (e.status !== "paid" && !e._optimistic)) && typeof onMarkPaid === "function" && (
                <button
                  style={{
                    ...fw.markPaidBtn,
                    opacity: markPaidBusy ? 0.75 : 1,
                    cursor: markPaidBusy ? "default" : "pointer",
                  }}
                  type="button"
                  disabled={markPaidBusy}
                  onClick={async () => {
                    if (markPaidBusy) return;
                    setMarkPaidBusy(true);
                    const startedAt = Date.now();

                    try {
                      await onMarkPaid(e.id);
                    } finally {
                      const elapsed = Date.now() - startedAt;
                      const wait = Math.max(0, 400 - elapsed);
                      if (wait > 0) {
                        setTimeout(() => setMarkPaidBusy(false), wait);
                      } else {
                        setMarkPaidBusy(false);
                      }
                    }
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
                    {markPaidBusy && (
                      <span
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: 999,
                          border: "2px solid rgba(255,255,255,0.55)",
                          borderTopColor: "#fff",
                          animation: "stSpin 0.8s linear infinite",
                          display: "inline-block",
                        }}
                      />
                    )}
                    {markPaidBusy ? "Marking…" : "✓ Mark Paid"}
                  </span>
                </button>
              )}

              {!isCam && typeof onDelete === "function" && (
                <button
                  style={{
                    ...fw.deleteBtn,
                    opacity: deleteBusy ? 0.8 : 1,
                    cursor: deleteBusy ? "default" : "pointer",
                  }}
                  type="button"
                  disabled={deleteBusy}
                  onClick={async () => {
                    if (deleteBusy) return;
                    setDeleteBusy(true);
                    const startedAt = Date.now();

                    try {
                      await onDelete(e.id);
                    } finally {
                      const elapsed = Date.now() - startedAt;
                      const wait = Math.max(0, 400 - elapsed);
                      if (wait > 0) {
                        setTimeout(() => setDeleteBusy(false), wait);
                      } else {
                        setDeleteBusy(false);
                      }
                    }
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                    {deleteBusy ? (
                      <span
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: 999,
                          border: "2px solid rgba(224,92,110,0.45)",
                          borderTopColor: "#E05C6E",
                          animation: "stSpin 0.8s linear infinite",
                          display: "inline-block",
                        }}
                      />
                    ) : (
                      <Icon path={icons.trash} size={16} color="#E05C6E" />
                    )}
                    <span>{deleteBusy ? "Deleting…" : "Delete"}</span>
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InsightsSection({ expenses }) {
  const [open, setOpen] = useState(false);

  const totalUnpaid = (expenses || [])
    .filter((e) => e.status !== "paid" && ["cam", "split"].includes(e.split))
    .reduce((s, e) => s + (e.split === "split" ? Number(e.amount || 0) / 2 : Number(e.amount || 0)), 0);

  return (
    <div style={fw.insightCard}>
      <div style={fw.insightHeader} onClick={() => setOpen((o) => !o)} role="button">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon path={icons.list} size={18} color="#2D1B5E" />
          <span style={fw.insightTitle}>Insights</span>
        </div>
        <span style={fw.chevron}>
          <Icon
            path={open ? icons.chevronUp : icons.chevronDown}
            size={16}
            color={open ? "#2D1B5E" : "#CCC"}
          />
        </span>
      </div>

      {open && (
        <div style={fw.insightBody}>
          <div style={fw.insightStat}>
            <span style={fw.insightStatLabel}>Cam still owes</span>
            <span style={fw.insightStatVal}>${totalUnpaid.toFixed(2)}</span>
          </div>
          <div style={fw.insightDivider} />
          <div style={fw.insightStat}>
            <span style={fw.insightStatLabel}>Total expenses</span>
            <span style={fw.insightStatVal}>{(expenses || []).length} items</span>
          </div>
        </div>
      )}
    </div>
  );
}

function SearchBar({ expenses, onFilter }) {
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState("");

  function handleChange(val) {
    setQuery(val);
    const q = String(val || "").toLowerCase();
    const filtered = (expenses || []).filter((e) =>
      String(e.description || "").toLowerCase().includes(q) ||
      String(e.category || "").toLowerCase().includes(q)
    );
    onFilter(filtered);
  }

  return (
    <div>
      <button
        style={fw.searchIconBtn}
        type="button"
        onClick={() => {
          setVisible((v) => !v);
          if (visible) {
            setQuery("");
            onFilter(expenses);
          }
        }}
        aria-label={visible ? "Close search" : "Search"}
      >
        <Icon path={icons.search} size={16} color="#2D1B5E" />
      </button>

      {visible && (
        <div style={fw.searchBar}>
          <input
            style={fw.searchInput}
            placeholder="Search expenses…"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            autoFocus
            onKeyDown={(ev) => {
              if (ev.key === "Escape") {
                ev.preventDefault();
                setVisible(false);
                setQuery("");
                onFilter(expenses);
              }
            }}
          />
          {query.length > 0 && (
            <button style={fw.searchClear} type="button" onClick={() => { setQuery(""); onFilter(expenses); }}>
              <Icon path={icons.x} size={14} color="#888" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MonthlySummaryCard({ expenses }) {
  const [open, setOpen] = useState(false);

  const now = new Date();
  const month = now.toLocaleString("en-US", { month: "long" });
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const thisMonth = (expenses || []).filter((e) => String(e.date || "").startsWith(monthKey));
  const total = thisMonth.reduce((s, e) => s + Number(e.amount || 0), 0);
  const camTotal = thisMonth
    .filter((e) => ["cam", "split"].includes(e.split))
    .reduce((s, e) => s + (e.split === "split" ? Number(e.amount || 0) / 2 : Number(e.amount || 0)), 0);

  return (
    <div style={fw.summaryCard} onClick={() => setOpen((o) => !o)} role="button">
      <div style={fw.summaryTop}>
        <div>
          <p style={fw.summaryMonth}>{month} Summary</p>
          <p style={fw.summaryTotal}>${total.toFixed(2)} total</p>
        </div>
        <span style={fw.chevron}>
          <Icon
            path={open ? icons.chevronUp : icons.chevronDown}
            size={18}
            color="#fff"
          />
        </span>
      </div>

      {open && (
        <div style={fw.summaryBreakdown}>
          <div style={fw.summaryRow}>
            <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 13 }}>Cam owes (this month)</span>
            <span style={{ color: "#A8EFC4", fontWeight: 700 }}>${camTotal.toFixed(2)}</span>
          </div>
          <div style={fw.summaryRow}>
            <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 13 }}>Your expenses</span>
            <span style={{ color: "#fff", fontWeight: 700 }}>${(total - camTotal).toFixed(2)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function PaymentTimeline({ payments, targets = [] }) {
  const [open, setOpen] = useState(false);
  const confirmed = (payments || []).filter((p) => p && p.confirmed);
  const targetLabelByKey = new Map((targets || []).map((t) => [t.key, t.label]));
  function resolveLabel(p) {
    const key = p.appliedToKey || (p.appliedToGroupId ? `grp:${p.appliedToGroupId}` : "general");
    if (!key || key === "general") return "General payment";
    return targetLabelByKey.get(key) || "Payment";
  }

  return (
    <div style={fw.timelineCard}>
      <div style={fw.timelineHeader} onClick={() => setOpen((o) => !o)} role="button">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon path={icons.wallet} size={16} color="#2D1B5E" />
          <span style={fw.insightTitle}>Payment History</span>
          {confirmed.length > 0 && <span style={fw.countBadge}>{confirmed.length}</span>}
        </div>
        <span style={fw.chevron}>
          <Icon
            path={open ? icons.chevronUp : icons.chevronDown}
            size={16}
            color={open ? "#2D1B5E" : "#CCC"}
          />
        </span>
      </div>

      {open && (
        <div style={{ padding: "8px 16px 12px" }}>
          {confirmed.length === 0 ? (
            <p style={{ color: "#999", fontSize: 13, textAlign: "center", padding: "16px 0" }}>
              No confirmed payments yet
            </p>
          ) : (
            confirmed.map((p, i) => (
              <div key={p.id || i} style={fw.timelineItem}>
                <div style={fw.timelineLine}>
                  <div style={fw.timelineDot} />
                  {i < confirmed.length - 1 && <div style={fw.timelineConnector} />}
                </div>
                <div style={fw.timelineContent}>
                  <p style={fw.timelineAmt}>${Number(p.amount || 0).toFixed(2)}</p>
                  <p style={fw.timelineMeta}>{resolveLabel(p)} · {p.method} · {formatHistoryDate(p.date)}</p>
                  {p.note && <p style={fw.timelineNote}>"{p.note}"</p>}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── ADD EXPENSE MODAL ─────────────────────────────────────────────────
function AddExpenseModal({ onSave, onClose, user }) {
  const [form, setForm] = useState({
    description: "",
    amount: "",
    split: "split",
    date: new Date().toISOString().split("T")[0],
    dueDate: "",
    endDate: "",
    repeatCount: "",
    account: "Navy Platinum",
    category: "Groceries",
    recurring: "none",
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const previewNextDue =
    form.recurring && form.recurring !== "none" && form.dueDate
      ? getNextDueDate(form.dueDate, form.recurring)
      : "";

  return (
    <div style={styles.modalOverlay}>
      <div style={styles.modal}>
        <div style={styles.dragHandle} />

        <div style={styles.modalHeader}>
          <h3 style={styles.modalTitle}>Add Expense</h3>
          <button style={styles.closeBtn} onClick={onClose}>
            <Icon path={icons.x} size={18} color="#C0485A" />
          </button>
        </div>

        <div style={styles.form}>
          {/* Transaction Details */}
          <div style={styles.sectionLabelRow}>
            <span style={styles.sectionLabel}>Transaction details</span>
          </div>

          <label style={styles.fieldLabel}>Description</label>
          <input
            style={styles.input}
            placeholder="e.g. Netflix, Wegmans…"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />

          <label style={styles.fieldLabel}>Amount ($)</label>
          <div style={{ position: "relative" }}>
            <span style={styles.dollarSign}>$</span>
            <input
              style={{ ...styles.input, paddingLeft: 28, fontSize: 20, fontWeight: 700 }}
              type="number"
              placeholder="0.00"
              value={form.amount}
              onChange={(e) => set("amount", e.target.value)}
            />
          </div>

          <div style={styles.twoCol}>
            <div style={{ flex: 1 }}>
              <label style={styles.fieldLabel}>Transaction date</label>
              <input
                style={styles.input}
                type="date"
                value={form.date}
                onChange={(e) => set("date", e.target.value)}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={styles.fieldLabel}>Reference # (optional)</label>
              <input
                style={styles.input}
                placeholder="TXN-4821"
                value={form.referenceNum || ""}
                onChange={(e) => set("referenceNum", e.target.value)}
              />
            </div>
          </div>
          <p style={styles.hintText}>Optional — from bank statement or receipt</p>

          {/* Schedule */}
          <div style={styles.sectionLabelRow}>
  <span style={styles.sectionLabel}>Schedule</span>
  {form.recurring && form.recurring !== "none" && <span style={styles.newBadge}>NEW</span>}
</div>

          <label style={styles.fieldLabel}>Frequency</label>
          <div style={styles.chipRow}>
            {[["none", "One-time"], ["weekly", "Weekly"], ["biweekly", "Biweekly"], ["monthly", "Monthly"]].map(
              ([val, label]) => (
                <button
                  key={val}
                  type="button"
                  style={{
                    ...styles.freqBtn,
                    ...(form.recurring === val ? styles.freqBtnActive : {}),
                  }}
                  onClick={() => set("recurring", val)}
                >
                  {label}
                </button>
              )
            )}
          </div>

          {(!form.recurring || form.recurring === "none") && (
            <>
              <label style={styles.fieldLabel}>Due date (optional)</label>
              <input
                style={styles.input}
                type="date"
                value={form.dueDate}
                onChange={(e) => set("dueDate", e.target.value)}
              />
            </>
          )}

          {form.recurring && form.recurring !== "none" && (
          <div style={styles.dueDateBox}>
            <div style={styles.twoCol}>
              <div style={{ flex: 1 }}>
                <label style={styles.fieldLabel}>First due date</label>
                <input
                  style={styles.input}
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => set("dueDate", e.target.value)}
                />
              </div>
              {form.recurring && form.recurring !== "none" && (
                <div style={{ flex: 1 }}>
                  <label style={styles.fieldLabel}>Auto-advance to</label>
                  <div style={styles.previewPill}>
                    Next: <strong>{formatHistoryDate(previewNextDue)}</strong>
                  </div>
                </div>
              )}
            </div>

              <>
                <div style={styles.endDateDivider} />

                <label style={styles.fieldLabel}>End date (optional)</label>
                <input
                  style={styles.input}
                  type="date"
                  value={form.endDate}
                  min={form.dueDate || undefined}
                  onChange={(e) => set("endDate", e.target.value)}
                />

                <label style={styles.fieldLabel}>Repeat count (optional)</label>
                <input
                  style={styles.input}
                  type="number"
                  min="1"
                  placeholder="e.g. 8"
                  value={form.repeatCount}
                  onChange={(e) => set("repeatCount", e.target.value)}
                />

                <p style={styles.hintText}>
                  Stops repeating when end date is reached or repeat count runs out.
                </p>
              </>
          </div>
          )}

          {/* Who Pays */}
          <div style={styles.sectionLabelRow}>
            <span style={styles.sectionLabel}>Who pays?</span>
          </div>

          <div style={styles.splitRow}>
            {(
              user === "cam"
                ? [["cam", "I pay", "#E8A0B0"], ["ella", "Emmanuella pays", "#7BBFB0"], ["split", "Split 50/50", "#C4A8D4"]]
                : [["mine", "I pay", "#7BBFB0"], ["cam", "Cam pays", "#E8A0B0"], ["split", "Split 50/50", "#C4A8D4"]]
            ).map(([val, label, color]) => (
              <button
                key={val}
                type="button"
                style={{
                  ...styles.splitOption,
                  background: form.split === val ? color : "#F5F0FB",
                  color: form.split === val ? "#fff" : "#666",
                  fontWeight: form.split === val ? 700 : 500,
                }}
                onClick={() => set("split", val)}
              >
                {label}
              </button>
            ))}
          </div>

          <label style={styles.fieldLabel}>Account</label>
          <select style={styles.input} value={form.account} onChange={(e) => set("account", e.target.value)}>
            {["Navy Platinum", "Best Buy Visa", "Klarna", "Affirm", "Cash", "Zelle"].map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>

          <div style={styles.sectionLabelRow}>
            <span style={styles.sectionLabel}>Category</span>
          </div>

          <div style={styles.catRow}>
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                style={{
                  ...styles.catChip,
                  background: form.category === c ? "#2D1B5E" : "#F5F0FB",
                  color: form.category === c ? "#fff" : "#666",
                  borderColor: form.category === c ? "#2D1B5E" : "#E5DFF5",
                }}
                onClick={() => set("category", c)}
              >
                {c}
              </button>
            ))}
          </div>

          <button
            style={styles.saveBtn}
            onClick={() => {
              if (!form.description || !form.amount) return;
              const repeatCountNum = form.repeatCount ? parseInt(form.repeatCount, 10) : null;

              const data = {
                ...form,
                amount: parseFloat(form.amount),
                nextDue: form.dueDate || null,
                repeatCount: repeatCountNum,
                repeatCountRemaining: repeatCountNum,
              };

              if (!data.dueDate) delete data.dueDate;
              if (!data.endDate) delete data.endDate;

              if (!repeatCountNum) {
                delete data.repeatCount;
                delete data.repeatCountRemaining;
              }

              onSave(data);
            }}
            type="button"
          >
            Save Expense
          </button>
        </div>
      </div>
    </div>
  );
}
//
// ★ CHANGE 4: Fixed LogPaymentModal — defaultAppliedToKey → initialAppliedToKey, added set() helper, added selectedTarget
//
function LogPaymentModal({ balance, onSave, onClose, user, targets = [], planSummaries, targetSummaries, initialAppliedToKey }) {
  const [form, setForm] = useState({
    amount: "",
    method: "Zelle",
    date: new Date().toISOString().split("T")[0],
    note: "",
    appliedToKey: initialAppliedToKey || "general",
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Compute selectedTarget from the current form key
  const selectedTarget = (() => {
    const key = form.appliedToKey;
    if (!key || key === "general" || !targetSummaries) return null;
    return targetSummaries.get(key) || null;
  })();

  const targetRemaining = selectedTarget ? selectedTarget.remaining : null;
  const suggestedAmount = selectedTarget ? selectedTarget.suggested : null;
  const maxForTarget = selectedTarget ? Math.max(0, Math.abs(Number(targetRemaining || 0))) : null;
  return (
    <div style={styles.modalOverlay}>
      <div style={styles.modal}>
        <div style={styles.modalHeader}>
          <h3 style={styles.modalTitle}>Log Payment</h3>
          <button style={styles.closeBtn} onClick={onClose}><Icon path={icons.x} size={18} color="#C0485A" /></button>
        </div>
        {user === "cam" && (
          <div style={{...styles.alertBox, margin: "0 0 16px", background: "#FBF5E0", borderColor: "#E8C878"}}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <p style={{color: "#7A5A10", fontSize: 13, margin: 0}}>
                Current balance: <strong>${balance.toFixed(2)}</strong>
              </p>
              {selectedTarget && (
                <p style={{color: "#7A5A10", fontSize: 12, margin: 0}}>
                  {selectedTarget.label}: <strong>${Number(targetRemaining || 0).toFixed(2)}</strong> remaining
                </p>
              )}
            </div>
          </div>
        )}
        <div style={styles.form}>
          <label style={styles.label}>Amount ($)</label>
          <input style={styles.input} type="number" placeholder="0.00" value={form.amount} onChange={e => set("amount", e.target.value)} />
          {selectedTarget && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
              <span style={{ fontSize: 12, color: "#7A5A10" }}>
                Suggested: <strong>${Number(suggestedAmount || 0).toFixed(2)}</strong>
              </span>
              <button
                type="button"
                style={{ background: "none", border: "none", color: "#7BBFB0", fontWeight: 700, cursor: "pointer", fontSize: 12 }}
                onClick={() => {
                  const s = Math.max(0, Number(suggestedAmount || 0));
                  const cap = maxForTarget == null ? s : Math.min(s, maxForTarget);
                  set("amount", String(Number(cap).toFixed(2)));
                }}
              >
                Use suggested
              </button>
            </div>
          )}

          <label style={styles.label}>Apply payment to</label>
          <select
            style={styles.input}
            value={form.appliedToKey}
            onChange={(e) => {
              const key = e.target.value;
              set("appliedToKey", key);
              // If user hasn't typed an amount yet, auto-fill a suggested amount for the selected target.
              if (!form.amount && targetSummaries && key !== "general") {
                const s = targetSummaries.get(key);
                if (s && s.suggested != null) {
                  const suggested = Math.max(0, Number(s.suggested || 0));
                  const cap = Math.max(0, Math.abs(Number(s.remaining || 0)));
                  set("amount", String(Number(Math.min(suggested, cap)).toFixed(2)));
                }
              }
            }}
          >
            {(targets.length ? targets : [{ key: "general", label: "General (not assigned)" }]).map((t) => {
              const summary =
                targetSummaries && t.key && t.key !== "general" ? targetSummaries.get(t.key) : null;
              const remainingText = summary
                ? ` · $${Number(summary.remaining || 0).toFixed(2)} remaining`
                : "";

              return (
                <option key={t.key} value={t.key}>
                  {t.label}{remainingText}
                </option>
              );
            })}
          </select>

          <label style={styles.label}>How did you pay?</label>
          <div style={styles.splitRow}>
            {["Zelle","Cash App","Venmo","Cash","Apple Pay"].map(m => (
              <button key={m} style={{
                ...styles.splitOption,
                fontSize: 12,
                background: form.method === m ? "#7BBFB0" : "#F5F0FB",
                color: form.method === m ? "#fff" : "#666",
                fontWeight: form.method === m ? 700 : 400,
              }} onClick={() => set("method", m)}>{m}</button>
            ))}
          </div>

          <label style={styles.label}>Date</label>
          <input style={styles.input} type="date" value={form.date} onChange={e => set("date", e.target.value)} />

          <label style={styles.label}>Note (optional)</label>
          <input style={styles.input} placeholder="e.g. for the groceries" value={form.note} onChange={e => set("note", e.target.value)} />

          {user === "cam" && <p style={styles.formNote}>⚠️ Emmanuella will confirm once she receives it</p>}

          <button style={{...styles.saveBtn, background: "linear-gradient(135deg, #7BBFB0, #5CA89A)"}} onClick={() => {
            if (!form.amount) return;
            const key = form.appliedToKey || "general";
            const legacyGroupId = key.startsWith("grp:") ? key.slice(4) : undefined;
            onSave({
              ...form,
              amount: parseFloat(form.amount),
              appliedToKey: key,
              ...(legacyGroupId ? { appliedToGroupId: legacyGroupId } : {}),
            });
          }}>Submit Payment</button>
        </div>
      </div>
    </div>
  );
}

// ── BOTTOM NAV ────────────────────────────────────────────────────────
function BottomNav({ screen, onNavigate, urgentCount = 0 }) {
  const tabs = [
    { id: "dashboard", icon: icons.home, label: "Home" },
    { id: "expenses", icon: icons.list, label: "Expenses" },
    { id: "urgent", icon: icons.fire, label: "Urgent" },
    { id: "history", icon: icons.clock, label: "History" },
  ];
  return (
    <div style={styles.bottomNav}>
      {tabs.map(t => (
        <button
          key={t.id}
          style={{ ...styles.navBtn, ...(screen === t.id ? styles.navBtnActive : {}) }}
          onClick={() => onNavigate(t.id)}
        >
          <div style={{ position: "relative" }}>
            <Icon
              path={t.icon}
              size={20}
              color={
                screen === t.id
                  ? "#7BBFB0"
                  : t.id === "urgent" && urgentCount > 0
                  ? "#E05C6E"
                  : "#AAA"
              }
            />
            {t.id === "urgent" && urgentCount > 0 && (
              <span
                style={{
                  position: "absolute",
                  top: -4,
                  right: -6,
                  background: "#E05C6E",
                  color: "#fff",
                  borderRadius: 10,
                  fontSize: 9,
                  fontWeight: 800,
                  padding: "1px 5px",
                  minWidth: 14,
                  textAlign: "center",
                }}
              >
                {urgentCount}
              </span>
            )}
          </div>
          <span
            style={{
              fontSize: 10,
              color:
                screen === t.id
                  ? "#7BBFB0"
                  : t.id === "urgent" && urgentCount > 0
                  ? "#E05C6E"
                  : "#AAA",
            }}
          >
            {t.label}
          </span>
        </button>
      ))}
    </div>
  );
}

// ── FRAMEWORK STYLES ─────────────────────────────────────────────────
const fw = {
  expenseCard: { background: "#fff", borderRadius: 16, marginBottom: 8, overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  expenseTop: { display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", cursor: "pointer" },
  expenseInfo: { flex: 1, minWidth: 0 },
  expenseDesc: { fontSize: 13, fontWeight: 600, color: "#2D1B5E", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  expenseMeta: { fontSize: 11, color: "#999", margin: "2px 0 0" },
  expenseRight: { textAlign: "right", flexShrink: 0 },
  expenseTotal: { fontSize: 14, fontWeight: 700, color: "#2D1B5E", margin: 0 },
  expenseCam: { fontSize: 11, color: "#E8A0B0", margin: "1px 0 0", fontWeight: 600 },
  splitDot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  chevron: { display: "flex", alignItems: "center", justifyContent: "center", marginTop: 4 },
  deleteBtn: { flex: 1, padding: "9px", borderRadius: 12, border: "none", background: "#FFF0F0", color: "#C0485A", fontWeight: 700, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 },

// Payment plan UI (Cam view)
payPlanCard: {
  marginTop: 12,
  background: "#fff",
  borderRadius: 16,
  border: "1px solid #F0EAF8",
  boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  padding: "12px 12px",
},
payPlanTop: {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 10,
},
payPlanPill: {
  fontSize: 10,
  fontWeight: 900,
  color: "#7A1C3E",
  background: "#FFF0F0",
  border: "1px solid #E8A0B0",
  borderRadius: 999,
  padding: "4px 10px",
  flexShrink: 0,
},
payPlanStepText: {
  fontSize: 12,
  fontWeight: 800,
  color: "#2D1B5E",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
},
payPlanCircles: {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexShrink: 0,
},
payPlanCircle: {
  width: 10,
  height: 10,
  borderRadius: 999,
  border: "2px solid #E5DFF5",
  background: "#fff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
},
payPlanCircleDone: {
  border: "2px solid #7BBFB0",
  background: "#7BBFB0",
},
payPlanBarTrack: {
  height: 8,
  borderRadius: 999,
  background: "#F5F0FB",
  overflow: "hidden",
},
payPlanBarFill: {
  height: "100%",
  borderRadius: 999,
  background: "linear-gradient(135deg, #7BBFB0, #5CA89A)",
},
payPlanNextRow: {
  marginTop: 10,
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "space-between",
  gap: 10,
},
payPlanNextLabel: {
  fontSize: 10,
  fontWeight: 900,
  color: "#AAA",
  textTransform: "uppercase",
  letterSpacing: 0.6,
},
payPlanNextSub: {
  marginTop: 3,
  fontSize: 12,
  fontWeight: 700,
  color: "#888",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
},
payPlanNextRight: {
  textAlign: "right",
  flexShrink: 0,
},
payPlanNextAmt: {
  fontSize: 14,
  fontWeight: 900,
  color: "#2D1B5E",
},
payPlanNextDate: {
  marginTop: 2,
  fontSize: 11,
  fontWeight: 700,
  color: "#999",
},

payMetaCard: {
  marginTop: 10,
  background: "#fff",
  borderRadius: 16,
  border: "1px solid #F0EAF8",
  boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  padding: "12px 12px",
},
payMetaRow: {
  display: "flex",
  alignItems: "stretch",
  gap: 0,
},
payMetaStat: {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 3,
},
payMetaLabel: {
  fontSize: 10,
  fontWeight: 900,
  color: "#AAA",
  textTransform: "uppercase",
  letterSpacing: 0.6,
},
payMetaVal: {
  fontSize: 14,
  fontWeight: 900,
  color: "#2D1B5E",
},
payMetaDivider: {
  width: 1,
  background: "#F0EAF8",
  margin: "0 10px",
},
logPayBtn: {
  width: "100%",
  marginTop: 10,
  border: "none",
  borderRadius: 14,
  height: 44,
  padding: "0 12px",
  fontSize: 13,
  fontWeight: 900,
  lineHeight: 1,
  cursor: "pointer",
  color: "#fff",
  background: "linear-gradient(135deg, #C4A8D4, #A88CC0)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  boxSizing: "border-box",
},

  expandPanel: { padding: "14px 16px 16px", borderTop: "1px solid #F5F0FB" },
  detailRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #F9F5FF" },
  detailLabel: { fontSize: 11, color: "#AAA", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 },
  detailVal: { fontSize: 13, color: "#2D1B5E", fontWeight: 600 },
  statusBadge: { fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 8 },
  splitChip: { fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 8 },

  noteInput: { width: "100%", maxWidth: "100%", boxSizing: "border-box", display: "block", padding: "12px 14px", borderRadius: 14, border: "1.5px solid #E5DFF5", fontSize: 15, lineHeight: 1.4, fontFamily: "inherit", outline: "none", marginTop: 8, background: "#fff" },
  noteTextarea: { width: "100%", maxWidth: "100%", boxSizing: "border-box", display: "block", padding: "12px 14px", borderRadius: 14, border: "1.5px solid #E5DFF5", fontSize: 15, lineHeight: 1.45, fontFamily: "inherit", outline: "none", marginTop: 8, background: "#fff", resize: "vertical", minHeight: 84 },
  noteSaveBtn: { flex: 1, marginTop: 0, padding: "8px 16px", borderRadius: 12, border: "none", background: "#7BBFB0", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer" },
  noteBtnRow: { display: "flex", gap: 10, marginTop: 10 },
  noteCancelBtn: { flex: 1, padding: "8px 16px", borderRadius: 12, border: "1.5px solid #E5DFF5", background: "#F5F0FB", color: "#2D1B5E", fontWeight: 700, fontSize: 12, cursor: "pointer" },
  noteTap: { fontSize: 13, lineHeight: 1.4, color: "#777", fontStyle: "italic", marginTop: 6, marginBottom: 0, cursor: "pointer" },

  actionBtns: { display: "flex", gap: 8, marginTop: 12 },
  markPaidBtn: { flex: 1, padding: "9px", borderRadius: 12, border: "none", background: "#7BBFB0", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  deleteBtn: { flex: 1, padding: "9px", borderRadius: 12, border: "none", background: "#FFF0F0", color: "#E05C6E", fontWeight: 700, fontSize: 13, cursor: "pointer" },

  insightCard: { background: "#fff", borderRadius: 16, margin: "0 16px 12px", overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  insightHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", cursor: "pointer" },
  insightTitle: { fontSize: 14, fontWeight: 700, color: "#2D1B5E" },
  insightBody: { padding: "4px 16px 16px", display: "flex", gap: 12 },
  insightStat: { flex: 1, display: "flex", flexDirection: "column", gap: 2 },
  insightStatLabel: { fontSize: 11, color: "#AAA" },
  insightStatVal: { fontSize: 18, fontWeight: 800, color: "#2D1B5E" },
  insightDivider: { width: 1, background: "#F0EAF8" },

  searchIconBtn: { background: "#F5F0FB", border: "none", borderRadius: 10, padding: "6px 10px", fontSize: 16, cursor: "pointer" },
  searchBar: { padding: "8px 0 4px", position: "relative", display: "flex", alignItems: "center" },
  searchInput: { width: "100%", padding: "10px 36px 10px 14px", borderRadius: 12, border: "1.5px solid #E5DFF5", fontSize: 14, fontFamily: "inherit", outline: "none", background: "#FDFBFF" },
  searchClear: { position: "absolute", right: 10, background: "none", border: "none", color: "#BBB", fontSize: 14, cursor: "pointer" },

  summaryCard: { margin: "0 16px 12px", background: "linear-gradient(135deg, #2D1B5E, #5B3B8C)", borderRadius: 20, padding: "20px 20px", color: "#fff", cursor: "pointer", boxShadow: "0 8px 30px rgba(45,27,94,0.25)" },
  summaryTop: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  summaryMonth: { fontSize: 13, opacity: 0.7, margin: 0 },
  summaryTotal: { fontSize: 28, fontWeight: 800, margin: "4px 0 0", letterSpacing: -1 },
  summaryBreakdown: { marginTop: 16, borderTop: "1px solid rgba(255,255,255,0.15)", paddingTop: 12 },
  summaryRow: { display: "flex", justifyContent: "space-between", marginBottom: 8 },

  timelineCard: { background: "#fff", borderRadius: 16, overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.06)", margin: "0 16px 12px" },
  timelineHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", cursor: "pointer" },
  countBadge: { background: "#7BBFB0", color: "#fff", fontSize: 11, fontWeight: 800, padding: "2px 8px", borderRadius: 10 },
  timelineItem: { display: "flex", gap: 12, marginBottom: 4 },
  timelineLine: { display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 4 },
  timelineDot: { width: 10, height: 10, borderRadius: "50%", background: "#7BBFB0", flexShrink: 0 },
  timelineConnector: { width: 2, flex: 1, background: "#F0EAF8", minHeight: 20, marginTop: 4 },
  timelineContent: { flex: 1, paddingBottom: 12 },
  timelineAmt: { fontSize: 14, fontWeight: 700, color: "#2D1B5E", margin: 0 },
  timelineMeta: { fontSize: 11, color: "#999", margin: "2px 0 0" },
  timelineNote: { fontSize: 11, color: "#BBB", fontStyle: "italic", margin: "2px 0 0" },
};

// ── STYLES ────────────────────────────────────────────────────────────
const styles = {
  app: { maxWidth: 430, margin: "0 auto", minHeight: "100vh", background: "#F8F4FF", position: "relative", fontFamily: "'DM Sans', system-ui, sans-serif" },
  screen: { padding: "0 0 20px", overflowY: "auto", maxHeight: "100vh" },

typeFilterRow: {
  display: "flex",
  gap: 8,
  padding: "10px 4px 0",
  margin: 0,
  overflowX: "auto",
  WebkitOverflowScrolling: "touch",
},

typeFilterChip: {
  flexShrink: 0,
  padding: "6px 14px",
  borderRadius: 999,
  border: "1.5px solid rgba(255,255,255,0.18)",
  background: "rgba(255,255,255,0.08)",
  color: "rgba(255,255,255,0.85)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  backdropFilter: "blur(8px)",
},

typeFilterChipActive: {
  background: "rgba(255,255,255,0.22)",
  borderColor: "rgba(255,255,255,0.28)",
  color: "#fff",
},

  // ---- Dynamic Island (Expenses) ----
  islandSticky: {
    position: "sticky",
    top: 0,
    zIndex: 60,
    padding: "46px 16px 10px",
    background: "linear-gradient(180deg, rgba(248,244,255,0.98), rgba(248,244,255,0.70), rgba(248,244,255,0))",
    backdropFilter: "blur(8px)",
  },
  islandCard: {
    background: "rgba(255,255,255,0.85)",
    border: "1.5px solid #F0EAF8",
    borderRadius: 26,
    padding: "12px 12px 12px",
    boxShadow: "0 10px 30px rgba(45,27,94,0.12)",
  },
  islandHeaderRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  islandTitle: {
    margin: 0,
    fontSize: 18,
    fontWeight: 900,
    color: "#2D1B5E",
    textAlign: "center",
    flex: 1,
    minWidth: 0,
  },
  islandRight: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  islandIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 14,
    border: "none",
    background: "rgba(255,255,255,0.7)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#2D1B5E",
    flexShrink: 0,
  },

  // Login
  loginWrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(160deg, #EDE4F5 0%, #EBF2F8 50%, #EBF6F4 100%)", padding: 20 },
  loginCard: { background: "#fff", borderRadius: 28, padding: "40px 28px", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.08)", width: "100%", maxWidth: 360 },
  loginLogo: { fontSize: 52, marginBottom: 8 },
  loginTitle: { fontSize: 32, fontWeight: 800, color: "#2D1B5E", margin: "0 0 6px", letterSpacing: -1 },
  loginSubtitle: { color: "#888", fontSize: 15, margin: "0 0 28px" },
  loginBtns: { display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 },
  loginBtn: { display: "flex", alignItems: "center", gap: 14, padding: "18px 22px", borderRadius: 16, border: "none", cursor: "pointer", color: "#fff", fontWeight: 700, fontSize: 17, position: "relative" },
  loginBtnIcon: { fontSize: 26 },
  loginBtnSub: { fontSize: 11, opacity: 0.8, position: "absolute", right: 18, fontWeight: 400 },
  loginNote: { fontSize: 11, color: "#AAA", margin: 0 },

  // Header
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "52px 20px 16px", background: "linear-gradient(160deg, #EDE4F5, #EBF6F4)" },
iconBtn: {
  width: 42,
  height: 42,
  borderRadius: 14,
  border: "none",
  cursor: "pointer",
  background: "rgba(255,255,255,0.85)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
},  
  searchBar: { margin: "-6px 16px 12px", background: "#fff", borderRadius: 14, border: "1px solid #F0EAF8", display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", boxShadow: "0 2px 10px rgba(0,0,0,0.04)" },
  searchIcon: { fontSize: 14, opacity: 0.7 },
  searchInput: { flex: 1, border: "none", outline: "none", fontSize: 13, background: "transparent", color: "#2D1B5E" },
  clearSearch: { width: 28, height: 28, borderRadius: 10, border: "none", cursor: "pointer", background: "#F5F0FB", color: "#888", display: "flex", alignItems: "center", justifyContent: "center" },
  expensesSearchRow: { display: "flex", alignItems: "center", gap: 10, padding: "0 16px 12px" },
  expensesSearchFieldWrap: { flex: 1, position: "relative", display: "flex", alignItems: "center" },
  expensesSearchIconInner: { position: "absolute", left: 12, display: "flex", alignItems: "center", justifyContent: "center" },
  expensesSearchInput: { width: "100%", padding: "10px 36px 10px 34px", borderRadius: 12, border: "1.5px solid #E5DFF5", background: "#fff", fontSize: 15, color: "#2D1B5E", outline: "none" },
  expensesSearchClearBtn: { position: "absolute", right: 10, width: 20, height: 20, borderRadius: 10, border: "none", cursor: "pointer", background: "#CCC", color: "#fff", fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" },
  expensesSearchCancel: { background: "none", border: "none", cursor: "pointer", color: "#7BBFB0", fontSize: 14, fontWeight: 700 },
  expensesResultCount: { padding: "0 16px 8px", fontSize: 12, color: "#AAA", fontWeight: 600 },
  searchEmptyWrap: { margin: "6px 16px 14px", background: "#fff", border: "1px solid #F0EAF8", borderRadius: 14, padding: "14px 14px", boxShadow: "0 2px 10px rgba(0,0,0,0.04)", textAlign: "center" },
  searchEmptyTitle: { margin: 0, fontSize: 14, fontWeight: 800, color: "#2D1B5E" },
  searchEmptySub: { margin: "6px 0 0", fontSize: 12, color: "#888" },
  searchEmptyCenter: { textAlign: "center", padding: "60px 20px" },
  searchEmptyEmoji: { fontSize: 48, marginBottom: 12 },
  headerGreet: { fontSize: 22, fontWeight: 800, color: "#2D1B5E", margin: 0 },
  headerSub: { fontSize: 12, color: "#888", margin: "2px 0 0" },
  logoutBtn: { fontSize: 12, color: "#888", background: "rgba(255,255,255,0.7)", border: "none", borderRadius: 20, padding: "6px 14px", cursor: "pointer" },

  // Balance Card
  balanceCard: { margin: "0 16px 20px", background: "linear-gradient(135deg, #2D1B5E, #5B3B8C)", borderRadius: 24, padding: "28px 24px", color: "#fff", boxShadow: "0 12px 40px rgba(45,27,94,0.25)" },
  balanceLabel: { fontSize: 13, opacity: 0.7, margin: "0 0 4px" },
  balanceAmount: { fontSize: 44, fontWeight: 800, margin: "0 0 20px", letterSpacing: -2 },
  balanceRow: { display: "flex", gap: 0 },
  balanceStat: { display: "flex", flexDirection: "column", flex: 1 },
  balanceStatLabel: { fontSize: 11, opacity: 0.6 },
  balanceStatVal: { fontSize: 18, fontWeight: 700 },
  balanceDivider: { width: 1, background: "rgba(255,255,255,0.2)", margin: "0 20px" },
  urgentBanner: { margin: "0 16px 16px", background: "linear-gradient(135deg, #FFF0F0, #FFF5EC)", borderRadius: 16, padding: "16px 18px", border: "1.5px solid #E8A0B0", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", boxShadow: "0 4px 16px rgba(224,92,110,0.12)" },
  urgentBannerTitle: { fontSize: 14, fontWeight: 800, color: "#E05C6E", margin: 0 },
  urgentBannerSub: { fontSize: 11, color: "#C06070", margin: "2px 0 0" },

  // Sections
  section: { padding: "0 16px", marginBottom: 8 },
  sectionHeader: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12, paddingTop: 16 },
  sectionTitle: { fontSize: 14, fontWeight: 700, color: "#2D1B5E" },
  seeAll: { fontSize: 12, color: "#7BBFB0", background: "none", border: "none", cursor: "pointer", fontWeight: 600 },
  progressSubTitle: { margin: "6px 0 10px", fontSize: 12, fontWeight: 800, color: "#5B3B8C" },
  planCard: { background: "#fff", borderRadius: 16, padding: "14px 14px", marginBottom: 10, boxShadow: "0 2px 10px rgba(0,0,0,0.04)", border: "1px solid #F0EAF8" },
  planTopRow: { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" },
  planTitle: { margin: 0, fontSize: 13, fontWeight: 800, color: "#2D1B5E", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  planRemaining: { margin: 0, fontSize: 13, fontWeight: 800, color: "#5B3B8C", flexShrink: 0 },
  planMetaRow: { display: "flex", justifyContent: "space-between", marginTop: 6 },
  planMetaText: { fontSize: 11, color: "#888", fontWeight: 600 },
  progressTrack: { marginTop: 10, height: 10, background: "#F5F0FB", borderRadius: 999, overflow: "hidden" },
  progressFill: { height: "100%", background: "linear-gradient(135deg, #7BBFB0, #5CA89A)", borderRadius: 999 },
  oneTimeRow: { background: "#fff", borderRadius: 14, padding: "12px 14px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.04)", border: "1px solid #F0EAF8" },
  oneTimeLabel: { fontSize: 12, fontWeight: 700, color: "#2D1B5E", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240 },
  oneTimeAmt: { fontSize: 12, fontWeight: 800, color: "#E05C6E" },

  // Pending
  pendingCard: { background: "#FBF5E0", borderRadius: 14, padding: "14px 16px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #E8C878" },
  pendingAmt: { fontSize: 18, fontWeight: 800, color: "#5A3A10", margin: 0 },
  pendingMeta: { fontSize: 12, color: "#8A6A30", margin: "2px 0 0" },
  confirmBtn: { display: "flex", alignItems: "center", gap: 6, background: "#7BBFB0", color: "#fff", border: "none", borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" },

  alertBox: { margin: "0 16px 16px", padding: "12px 16px", borderRadius: 12, border: "1px solid", display: "flex", alignItems: "center", gap: 10 },

  // Action Buttons
  actionRow: { display: "flex", gap: 10, padding: "8px 16px 16px" },
  actionBtn: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "14px", borderRadius: 16, border: "none", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,0.12)" },

  // Expense Row
  expenseRow: { display: "flex", alignItems: "center", gap: 10, background: "#fff", borderRadius: 14, padding: "12px 14px", marginBottom: 8, boxShadow: "0 2px 8px rgba(0,0,0,0.04)" },
  splitDot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  expenseInfo: { flex: 1, minWidth: 0 },
  expenseDesc: { fontSize: 13, fontWeight: 600, color: "#2D1B5E", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  expenseMeta: { fontSize: 11, color: "#999", margin: "2px 0 0" },
  expenseAmts: { textAlign: "right", flexShrink: 0 },
  expenseTotal: { fontSize: 14, fontWeight: 700, color: "#2D1B5E", margin: 0 },
  expenseCam: { fontSize: 11, color: "#E8A0B0", margin: "1px 0 0", fontWeight: 600 },
  deleteBtn: { background: "rgba(192,72,90,0.1)", border: "none", padding: 4, marginTop: 6, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, width: 26, height: 26 },
  splitBadge: { borderRadius: 6, padding: "1px 6px", marginLeft: 4, fontSize: 10 },

  // Sub screens
  subHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "52px 16px 16px" },
  subTitle: { fontSize: 20, fontWeight: 800, color: "#2D1B5E", margin: 0 },
  backBtn: { background: "#fff", border: "none", borderRadius: 12, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.08)" },
  addSmall: { background: "#7BBFB0", border: "none", borderRadius: 12, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },

  filterRow: { display: "flex", gap: 8, padding: "0 16px 16px", overflowX: "auto" },
  filterTab: { flexShrink: 0, padding: "6px 16px", borderRadius: 20, border: "1px solid #E5DFF5", background: "#fff", fontSize: 13, color: "#888", cursor: "pointer" },
  filterTabActive: { background: "#2D1B5E", color: "#fff", borderColor: "#2D1B5E", fontWeight: 700 },

  // ---- Type filter chip styles ----
  typeFilterRow: {
    display: "flex",
    gap: 8,
    padding: "8px 0 6px",
    overflowX: "auto",
    WebkitOverflowScrolling: "touch",
  },
  typeChip: {
    flexShrink: 0,
    padding: "6px 14px",
    borderRadius: 999,
    border: "1px solid #E5DFF5",
    background: "#fff",
    fontSize: 12,
    color: "#888",
    cursor: "pointer",
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  typeChipActive: {
    background: "#2D1B5E",
    color: "#fff",
    borderColor: "#2D1B5E",
  },
  typeChipActiveCam: {
    background: "#FFF0F0",
    color: "#E05C6E",
    borderColor: "#E8A0B0",
  },


  
  // History
  historyItem: { display: "flex", gap: 12, padding: "12px 16px", borderBottom: "1px solid #F0EAF8", alignItems: "center" },
  historyIcon: { width: 38, height: 38, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 },
  historyInfo: { flex: 1 },
  historyDesc: { fontSize: 13, fontWeight: 600, color: "#2D1B5E", margin: 0 },
  historyMeta: { fontSize: 11, color: "#999", margin: "2px 0 0" },
  historyNote: { fontSize: 11, color: "#AAA", fontStyle: "italic", margin: "2px 0 0" },
  historyAmt: { textAlign: "right" },
  historyAmtText: { fontSize: 14, fontWeight: 700, margin: 0 },
  pendingBadge: { background: "#FBF5E0", color: "#C8A020", borderRadius: 6, padding: "1px 6px", fontSize: 10, marginLeft: 4 },
  confirmedBadge: { background: "#EEF5EC", color: "#1E8449", borderRadius: 6, padding: "1px 6px", fontSize: 10, marginLeft: 4 },
  miniConfirm: { fontSize: 11, background: "#7BBFB0", color: "#fff", border: "none", borderRadius: 8, padding: "4px 10px", cursor: "pointer", marginTop: 4, fontWeight: 600 },
  markPaidBtn: { marginTop: 10, background: "#2D1B5E", color: "#fff", border: "none", borderRadius: 10, padding: "8px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  markPaidSmall: { marginTop: 6, background: "#2D1B5E", color: "#fff", border: "none", borderRadius: 10, padding: "6px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" },
  menuWrap: { position: "relative", display: "inline-block", marginTop: 6 },
  menuDotBtn: { background: "#F5F0FB", border: "none", borderRadius: 10, fontSize: 18, fontWeight: 800, color: "#888", padding: "4px 10px", cursor: "pointer", letterSpacing: 1, minWidth: 40, minHeight: 36, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" },
  menuDotBtnActive: { background: "#EAE0F8", color: "#5B3B8C" },
  menuPopup: { position: "absolute", right: 0, top: "110%", background: "#fff", borderRadius: 14, boxShadow: "0 8px 30px rgba(0,0,0,0.15)", zIndex: 100, minWidth: 160, overflow: "hidden", border: "1px solid #F0EAF8" },
  menuItem: { display: "block", width: "100%", padding: "14px 18px", textAlign: "left", background: "none", border: "none", borderBottom: "1px solid #F5F0FB", fontSize: 14, fontWeight: 600, color: "#2D1B5E", cursor: "pointer", fontFamily: "'DM Sans', system-ui, sans-serif" },
  menuItemDelete: { borderBottom: "none", color: "#E05C6E" },

  // Modal
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" },
  modal: { background: "#fff", borderRadius: "24px 24px 0 0", padding: "24px 20px 40px", width: "100%", maxWidth: 430, maxHeight: "90vh", overflowY: "auto" },
  dragHandle: { width: 40, height: 4, background: "#E0D8F0", borderRadius: 2, margin: "12px auto 0" },
  sectionLabelRow: { display: "flex", alignItems: "center", gap: 6, margin: "18px 0 10px" },
  sectionLabel: { fontSize: 10, fontWeight: 800, color: "#C4A8D4", textTransform: "uppercase", letterSpacing: 1.2 },
  newBadge: { fontSize: 10, fontWeight: 800, background: "#EEF5EC", color: "#1E8449", borderRadius: 8, padding: "2px 8px" },
  fieldLabel: { display: "block", fontSize: 11, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 },
  hintText: { fontSize: 11, color: "#BBB", marginTop: 6, marginBottom: 8, paddingLeft: 2 },
  twoCol: { display: "flex", gap: 10 },
  chipRow: { display: "flex", gap: 6, flexWrap: "wrap" },
  freqBtn: { flex: 1, padding: "9px 6px", borderRadius: 12, border: "1.5px solid #E5DFF5", background: "#FDFBFF", fontSize: 12, fontFamily: "inherit", fontWeight: 600, color: "#999", cursor: "pointer" },
  freqBtnActive: { background: "#2D1B5E", borderColor: "#2D1B5E", color: "#fff" },
  dueDateBox: { background: "#FBF8FF", border: "1.5px solid #E5DFF5", borderRadius: 14, padding: "12px 12px 6px", marginBottom: 8 },
  endDateDivider: { height: 1, background: "#E5DFF5", margin: "10px 0" },
  dollarSign: { position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", fontSize: 16, fontWeight: 700, color: "#C4A8D4", pointerEvents: "none" },
  previewPill: { padding: "12px 14px", borderRadius: 12, border: "1.5px solid #E5DFF5", background: "#FDFBFF", fontSize: 13, color: "#888" },
  catRow: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  catChip: { padding: "6px 14px", borderRadius: 999, border: "1.5px solid #E5DFF5", background: "#F5F0FB", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  modalTitle: { fontSize: 20, fontWeight: 800, color: "#2D1B5E", margin: 0 },
  closeBtn: { background: "#FDE8EB", border: "none", borderRadius: 10, width: 32, height: 32, padding: 0, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 },

  form: { display: "flex", flexDirection: "column", gap: 8 },
  label: { fontSize: 12, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 8 },
  input: { padding: "12px 14px", borderRadius: 12, border: "1.5px solid #E5DFF5", fontSize: 15, outline: "none", background: "#FDFBFF" },
  splitRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  splitOption: { flex: 1, minWidth: 80, padding: "10px 8px", borderRadius: 12, border: "none", cursor: "pointer", fontSize: 13, transition: "all 0.15s" },
  saveBtn: { marginTop: 16, padding: "16px", borderRadius: 16, border: "none", background: "linear-gradient(135deg, #C4A8D4, #A88CC0)", color: "#fff", fontSize: 16, fontWeight: 800, cursor: "pointer" },
  formNote: { fontSize: 12, color: "#E8A020", background: "#FBF5E0", borderRadius: 10, padding: "8px 12px", margin: "4px 0 0", textAlign: "center" },


  
  // Bottom Nav
  bottomNav: { position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 430, background: "#fff", borderTop: "1px solid #F0EAF8", display: "flex", padding: "8px 0 20px", boxShadow: "0 -4px 20px rgba(0,0,0,0.06)", zIndex: 50 },
  navBtn: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, background: "none", border: "none", cursor: "pointer", padding: "6px 0" },
  navBtnActive: {},

  notification: { position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", padding: "12px 24px", borderRadius: 16, fontSize: 14, fontWeight: 700, zIndex: 999, boxShadow: "0 4px 20px rgba(0,0,0,0.15)", whiteSpace: "nowrap" },
};
// ── TARGET DETAILS SCREEN ────────────────────────────────────────────

function TargetDetailsScreen({ user, targetKey, targetSummaries, expenses, payments, onBack }) {
  const summary = targetSummaries && targetKey ? targetSummaries.get(targetKey) : null;

  const title = summary?.label || "Details";

  const relatedExpenses = (() => {
    if (!targetKey) return [];
    if (targetKey.startsWith("grp:")) {
      const gid = targetKey.slice(4);
      return (expenses || []).filter((e) => (e.groupId || e.id) === gid);
    }
    if (targetKey.startsWith("exp:")) {
      const id = targetKey.slice(4);
      return (expenses || []).filter((e) => e.id === id);
    }
    return [];
  })();

  const relatedPayments = (() => {
    if (!targetKey) return [];
    return (payments || []).filter((p) => {
      const key = p.appliedToKey || (p.appliedToGroupId ? `grp:${p.appliedToGroupId}` : "general");
      return key === targetKey;
    });
  })().sort((a, b) => new Date(b.date) - new Date(a.date));
  const pendingPayments = relatedPayments.filter((p) => !p.confirmed);
  const confirmedPayments = relatedPayments.filter((p) => p.confirmed);
  const charged = Number(summary?.charged || 0);
  const paid = Number(summary?.paid || 0);
  const remaining = Number(summary?.remaining || 0);
  const pct = charged !== 0 ? Math.max(0, Math.min(1, Math.abs(paid) / Math.abs(charged))) : 0;

  return (
    <div style={styles.screen}>
      <div style={styles.subHeader}>
        <button
          type="button"
          style={{
            ...styles.logoutBtn,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "6px 12px",
            minWidth: 40,
            height: 32,
            background: "rgba(255,255,255,0.7)",
            color: "#2D1B5E",
          }}
          onClick={onBack}
          aria-label="Back"
        >
          <Icon path={icons.back} size={18} />
        </button>

        <h2 style={{ ...styles.subTitle, flex: 1, textAlign: "center", minWidth: 0 }}>{title}</h2>

        <div style={{ minWidth: 40, height: 32 }} />
      </div>

      {summary && (
        <div style={{ ...styles.section, paddingTop: 0 }}>
          <div style={styles.planCard}>
            <div style={styles.planTopRow}>
              <p style={styles.planTitle}>{summary.label}</p>
              <p style={styles.planRemaining}>${remaining.toFixed(2)} left</p>
            </div>
            <div style={styles.planMetaRow}>
              <span style={styles.planMetaText}>Paid: ${paid.toFixed(2)}</span>
              <span style={styles.planMetaText}>Total: ${charged.toFixed(2)}</span>
            </div>
            <div style={styles.progressTrack}>
              <div style={{ ...styles.progressFill, width: `${pct * 100}%` }} />
            </div>
          </div>
        </div>
      )}

      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionTitle}>Related charges</span>
        </div>
        {relatedExpenses.length === 0 ? (
          <p style={{ color: "#999", fontSize: 13, margin: "0 0 12px" }}>No charges found.</p>
        ) : (
          relatedExpenses
            .slice()
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .map((e) => (
              <ExpenseRow key={e.id} expense={e} detailed user={user} />
            ))
        )}
      </div>

      <div style={styles.section}>
  <div style={{ ...styles.sectionHeader, justifyContent: "space-between" }}>
  <span style={styles.sectionTitle}>Payments</span>
  {pendingPayments.length > 0 && (
    <span style={{ fontSize: 12, color: "#C8A020", fontWeight: 700 }}>
      {pendingPayments.length} pending
    </span>
  )}
</div>

  {pendingPayments.length > 0 && (
    <div
      style={{
        ...styles.alertBox,
        margin: "0 0 12px",
        background: "#FBF5E0",
        borderColor: "#E8C878",
      }}
    >
      <Icon path={icons.clock} size={16} color="#C8A020" />
      <p style={{ color: "#7A5A10", fontSize: 13, margin: 0 }}>
        Pending payments will reduce the balance once Emmanuella confirms them.
      </p>
    </div>
  )}

  {relatedPayments.length === 0 ? (
    <p style={{ color: "#999", fontSize: 13, margin: 0 }}>No payments yet.</p>
  ) : (
    <>
      {pendingPayments.map((p) => (
        <div key={p.id} style={styles.oneTimeRow}>
          <span style={styles.oneTimeLabel}>
            {formatShortDate(p.date)} · {p.method}{" "}
            <span style={{ ...styles.pendingBadge, marginLeft: 6 }}>pending</span>
          </span>
          <span style={{ ...styles.oneTimeAmt, color: "#C8A020" }}>
            ${Number(p.amount || 0).toFixed(2)}
          </span>
        </div>
      ))}

      {confirmedPayments.length > 0 && pendingPayments.length > 0 && (
        <div style={{ height: 1, background: "#F0EAF8", margin: "6px 0 12px" }} />
      )}

      {confirmedPayments.map((p) => (
        <div key={p.id} style={styles.oneTimeRow}>
          <span style={styles.oneTimeLabel}>
            {formatShortDate(p.date)} · {p.method}
          </span>
          <span style={{ ...styles.oneTimeAmt, color: "#1E8449" }}>
            ${Number(p.amount || 0).toFixed(2)}
          </span>
        </div>
      ))}
    </>
  )}
</div>

      <div style={{ height: 80 }} />
    </div>
  );
}