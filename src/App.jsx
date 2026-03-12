import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithCredential, signOut, setPersistence, browserLocalPersistence } from "firebase/auth";
import { listenExpenses, listenPayments, addExpense, addPayment, confirmPayment as confirmPaymentInDb, deleteExpense as deleteExpenseInDb, deletePayment as deletePaymentInDb, updateExpense as updateExpenseInDb, resolveDispute as resolveDisputeInDb, rejectPayment as rejectPaymentInDb } from "./data";
import { auth } from "./firebase";
import { initPushNotifications } from "./pushNotifications";
import { Capacitor } from "@capacitor/core";
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
const SPLIT_COLORS = { mine: "#A6B49E", cam: "#E8A0B0", ella: "#A6B49E", split: "#D5BD96" };
const CATEGORIES = ["Groceries", "Household", "Insurance", "Subscriptions", "Utilities", "Entertainment", "Other"];

const EXPENSE_TEMPLATES = [
  { label: "Rent",             description: "Rent",             category: "Household",     recurring: "monthly", split: "split" },
  { label: "Internet",         description: "Internet",         category: "Utilities",     recurring: "monthly", split: "split" },
  { label: "Electric",         description: "Electric",         category: "Utilities",     recurring: "monthly", split: "split" },
  { label: "YouTube Premium",  description: "YouTube Premium",  category: "Subscriptions", recurring: "monthly", split: "cam",   amount: "8.50" },
  { label: "DoorDash",         description: "DoorDash",         category: "Other",         recurring: "monthly", split: "split" },
  { label: "Shipt",            description: "Shipt Membership", category: "Subscriptions", recurring: "monthly", split: "split" },
  { label: "Instacart",        description: "Instacart",        category: "Subscriptions", recurring: "monthly", split: "split" },
  { label: "Uber Eats",        description: "Uber Eats",        category: "Other",         recurring: "monthly", split: "split" },
];

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

// Renders a note string with bullet-point support.
// Lines starting with "• " are rendered as list items.
function renderNote(text, style = {}) {
  if (!text) return null;
  const lines = text.split("\n");
  return (
    <div style={{ fontSize: 13, lineHeight: 1.5, color: "#666", ...style }}>
      {lines.map((line, i) => {
        const isBullet = line.startsWith("• ");
        const content = isBullet ? line.slice(2) : line;
        if (!content && i < lines.length - 1) return <div key={i} style={{ height: 4 }} />;
        return (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
            {isBullet && <span style={{ flexShrink: 0, fontWeight: 700, color: "#A6B7CB", marginTop: 1 }}>•</span>}
            <span>{content}</span>
          </div>
        );
      })}
    </div>
  );
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

function formatPaymentDateTime(p) {
  const ts = p.createdAt;
  let d;
  if (ts && typeof ts.toDate === "function") {
    d = ts.toDate();
  } else if (ts && ts.seconds) {
    d = new Date(ts.seconds * 1000);
  } else if (p.date) {
    const fd = new Date(p.date + "T12:00:00");
    return fd.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } else {
    return "";
  }
  const mon = d.toLocaleDateString("en-US", { month: "short" });
  const day = d.getDate();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${mon} ${day} · ${time}`;
}

function PaymentMethodIcon({ method }) {
  const configs = {
    "Apple Pay":  { bg: "#000", color: "#fff", label: "Pay" },
    "Venmo":      { bg: "#008CFF", color: "#fff", label: "V" },
    "Zelle":      { bg: "#6D1ED4", color: "#fff", label: "Z" },
    "Cash App":   { bg: "#00C244", color: "#fff", label: "$" },
    "Cash":       { bg: "#2D5A4A", color: "#fff", label: "$" },
  };
  const cfg = configs[method] || { bg: "#A6B49E", color: "#fff", label: "P" };
  return (
    <div style={{ width: 44, height: 44, borderRadius: 12, background: cfg.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <span style={{ fontSize: method === "Apple Pay" ? 10 : 16, fontWeight: 900, color: cfg.color, letterSpacing: method === "Apple Pay" ? -0.3 : 0 }}>
        {cfg.label}
      </span>
    </div>
  );
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
        const ref = String(e.referenceNum || "").toLowerCase();
        return d.includes(q) || c.includes(q) || a.includes(q) || amt.includes(q) || due.includes(q) || ref.includes(q);
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
  // Mandatory expenses get an earlier critical window (7 days) and warning window (14 days)
  if (e.mandatory) {
    if (days <= 7) return "critical";
    if (days <= 14) return "warning";
    return null;
  }
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
  if (frequency === "monthly") {
    // Clamp to last day of target month so Jan 31 → Feb 28, not Mar 3
    const originalDay = dd;
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(originalDay, lastDay));
  }

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
  edit: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
  x: "M6 18L18 6M6 6l12 12",
  alert: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
  fire: "M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z",
  forward:     "M9 5l7 7-7 7",
  chevronDown: "M19 9l-7 7-7-7",
  chevronUp:   "M5 15l7-7 7 7",
  plusCircle:  "M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z",
  search:      "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z",
  trash:       "M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16",
  flag:        "M3 3v18M3 7l9-4 9 4v8l-9 4-9-4V7z",
  bell:        "M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9",
};

function Icon({ path, size = 20, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}

// ── UPDATE BANNER ─────────────────────────────────────────────────────
function UpdateBanner({ onTap }) {
  return (
    <motion.div
      initial={{ y: -72, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: -72, opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 28 }}
      onClick={onTap}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 99999,
        background: "linear-gradient(90deg, #00314B 0%, #1B4D6B 100%)",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        cursor: "pointer",
        paddingTop: "calc(env(safe-area-inset-top, 0px) + 12px)",
        paddingBottom: 12,
        boxShadow: "0 4px 24px rgba(0,49,75,0.4)",
      }}
    >
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#C5D9C2" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M16 8l-4-4-4 4M12 4v12" />
      </svg>
      <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.2 }}>
        SplitTrack updated — Tap to refresh
      </span>
    </motion.div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────────
export default function App() {
  const [firebaseUser, setFirebaseUser] = useState(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const realUser = roleFromEmail(firebaseUser?.email); // "emma" | "cam"
  const [viewAs, setViewAs] = useState(null); // null | "cam" — Emma can preview as Cameron
  const user = (realUser === "emma" && viewAs) ? viewAs : realUser;
  const [screen, setScreen] = useState("dashboard");
  const [activeTargetKey, setActiveTargetKey] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [payments, setPayments] = useState([]);
  const [notification, setNotification] = useState(null);
  const [modal, setModal] = useState(null); // "addExpense" | "logPayment" | "confirmPayment" | "camQuickPay"
  const [editingExpense, setEditingExpense] = useState(null);
  const [disputingExpense, setDisputingExpense] = useState(null);
  
  const [paymentDraftKey, setPaymentDraftKey] = useState("general");
  const [paymentDraftAmount, setPaymentDraftAmount] = useState(null);
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

  // Initialize push notifications once we know who the user is
  useEffect(() => {
    if (!realUser) return;
    initPushNotifications(realUser);

    // Handle notification taps when app is already open (service worker posts a message)
    const onSwMessage = (event) => {
      if (event.data?.type === "NAVIGATE" && event.data.screen) {
        setScreen(event.data.screen);
      }
    };
    navigator.serviceWorker?.addEventListener("message", onSwMessage);

    // Handle notification tap when app was closed (?screen= query param on launch)
    const params = new URLSearchParams(window.location.search);
    const screenParam = params.get("screen");
    if (screenParam) {
      setScreen(screenParam);
      window.history.replaceState({}, "", window.location.pathname);
    }

    return () => navigator.serviceWorker?.removeEventListener("message", onSwMessage);
  }, [realUser]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    /* global __BUILD_VERSION__ */
    const current = typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : "dev";
    const check = async () => {
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`);
        if (!res.ok) return;
        const { version } = await res.json();
        if (version && current !== "dev" && version !== current) setUpdateAvailable(true);
      } catch {}
    };
    check();
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
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

    // If this payment auto-marked an expense as paid, revert that status
    const pmtKey = payment.appliedToKey || (payment.appliedToGroupId ? `grp:${payment.appliedToGroupId}` : "general");
    let revertExpense = null;
    if (pmtKey && pmtKey.startsWith("exp:")) {
      const expId = pmtKey.slice(4);
      const exp = expenses.find((e) => e.id === expId);
      if (exp && exp.status === "paid") {
        // Check if any other confirmed payment still covers this expense
        const otherConfirmed = payments.filter((p) => p.id !== id && p?.confirmed && (p.appliedToKey === pmtKey || (p.appliedToGroupId && `grp:${p.appliedToGroupId}` === pmtKey)));
        if (otherConfirmed.length === 0) {
          revertExpense = exp;
          setExpenses((prev) => prev.map((e) => e.id === expId ? { ...e, status: "unpaid", paidAt: null } : e));
        }
      }
    }

    try {
      await deletePaymentInDb(id);
      if (revertExpense) {
        await updateExpenseInDb(revertExpense.id, { status: "unpaid", paidAt: null });
      }
      notify("Payment deleted.");
    } catch (err) {
      console.error("Failed to delete payment:", err);
      // Roll back
      setPayments((prev) => [removed, ...prev]);
      if (revertExpense) {
        setExpenses((prev) => prev.map((e) => e.id === revertExpense.id ? revertExpense : e));
      }
      notify("Couldn't delete payment. Check Firestore rules.", "error");
    }
  }

  async function handleResolveDispute(id, resolution, declineReason) {
    try {
      await resolveDisputeInDb(id, resolution, declineReason || null);
      setPayments((prev) => prev.map((p) => p.id === id ? { ...p, confirmed: true, disputeStatus: resolution, declineReason: declineReason || null } : p));
      notify(resolution === "accepted" ? "Dispute accepted — charge flagged for review." : "Dispute dismissed — charge stands.");
    } catch (err) {
      console.error("Failed to resolve dispute:", err);
      notify("Couldn't resolve dispute. Check connection.", "error");
    }
  }

  async function handleDismissRejectedPayment(id) {
    setPayments((prev) => prev.filter((p) => p.id !== id));
    try {
      await deletePaymentInDb(id);
      notify("Payment dismissed.");
    } catch (err) {
      console.error("Failed to dismiss payment:", err);
      const removed = payments.find((p) => p.id === id);
      if (removed) setPayments((prev) => [removed, ...prev]);
      notify("Couldn't dismiss payment. Check connection.", "error");
    }
  }

  async function handleRejectPayment(id, reason, suggestionKey) {
    try {
      await rejectPaymentInDb(id, reason || null, suggestionKey || null);
      setPayments((prev) => prev.map((p) => p.id === id ? { ...p, rejected: true, rejectionReason: reason || null, rejectionSuggestionKey: suggestionKey || null } : p));
      notify("Payment returned to Cameron with your feedback.");
    } catch (err) {
      console.error("Failed to reject payment:", err);
      notify("Couldn't send rejection. Check connection.", "error");
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

  async function handleEditExpense(id, updates) {
    try {
      await updateExpenseInDb(id, updates);
      setEditingExpense(null);
      notify("Expense updated!");
    } catch (err) {
      console.error("Failed to update expense:", err);
      notify("Couldn't update expense.", "error");
    }
  }

  if (!firebaseUser) return <LoginScreen />;

  return (
    <div style={{ ...styles.app, paddingTop: (realUser === "emma" && viewAs === "cam") ? 36 : 0 }}>
      <style>{`
        @keyframes stSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        @keyframes lgSettle{0%{transform:scaleX(1) scaleY(1)}30%{transform:scaleX(1.07) scaleY(0.88)}60%{transform:scaleX(0.97) scaleY(1.04)}80%{transform:scaleX(1.01) scaleY(0.99)}100%{transform:scaleX(1) scaleY(1)}}
        @keyframes lgShimmer{0%{opacity:0;transform:translateX(-100%) skewX(-12deg)}20%{opacity:1}100%{opacity:0;transform:translateX(280%) skewX(-12deg)}}
        .lg-pill{position:absolute;top:3px;bottom:3px;border-radius:11px;pointer-events:none;transition:left .4s cubic-bezier(.34,1.56,.64,1),width .4s cubic-bezier(.34,1.56,.64,1);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);background:linear-gradient(145deg,rgba(255,255,255,0.32) 0%,rgba(255,255,255,0.12) 100%);border:1px solid rgba(255,255,255,0.45);box-shadow:0 2px 12px rgba(0,0,0,0.14),0 1px 0 rgba(255,255,255,0.6) inset,0 -1px 0 rgba(0,0,0,0.06) inset;overflow:hidden}
        .lg-pill::after{content:'';position:absolute;top:0;bottom:0;width:40%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.55),transparent);animation:lgShimmer .7s ease forwards .05s}
        .lg-pill.lg-settle{animation:lgSettle .4s cubic-bezier(.34,1.56,.64,1) forwards}
        .lg-btn{position:relative;z-index:1;background:transparent;border:none;cursor:pointer;font-family:inherit;-webkit-tap-highlight-color:transparent;transition:color .22s ease,opacity .22s ease}
        .lg-btn:active{transform:scale(0.94);transition:transform .1s ease}
        .lg-chip-active{backdrop-filter:blur(16px) saturate(160%);-webkit-backdrop-filter:blur(16px) saturate(160%);box-shadow:0 2px 10px rgba(0,0,0,0.13),inset 0 1px 0 rgba(255,255,255,0.45)}
        .lg-nav-pill{position:absolute;border-radius:14px;pointer-events:none;transition:left .42s cubic-bezier(.34,1.56,.64,1),width .42s cubic-bezier(.34,1.56,.64,1),top .42s cubic-bezier(.34,1.56,.64,1),height .42s cubic-bezier(.34,1.56,.64,1);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);background:linear-gradient(145deg,rgba(255,255,255,0.22),rgba(255,255,255,0.08));border:1px solid rgba(255,255,255,0.35);box-shadow:0 2px 12px rgba(0,0,0,0.12),inset 0 1px 0 rgba(255,255,255,0.4);overflow:hidden}
        .lg-nav-pill::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.3),transparent);background-size:200% 100%;animation:lgShimmer .6s ease forwards .05s}
      `}</style>
      <AnimatePresence>
        {updateAvailable && <UpdateBanner onTap={() => window.location.reload()} />}
      </AnimatePresence>
      {/* Cameron view banner — shown when Emma is previewing as Cam */}
      {realUser === "emma" && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999,
          background: viewAs === "cam" ? "#00314B" : "transparent",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: viewAs === "cam" ? "8px 16px" : "0",
          height: viewAs === "cam" ? "auto" : 0,
          overflow: "hidden",
          transition: "all 0.2s ease",
        }}>
          {viewAs === "cam" && (
            <>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#C4B5FD", letterSpacing: 0.3 }}>
                Viewing as Cameron
              </span>
              <button
                onClick={() => setViewAs(null)}
                style={{ fontSize: 12, fontWeight: 700, color: "#fff", background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 8, padding: "4px 12px", cursor: "pointer" }}
              >
                Back to my view
              </button>
            </>
          )}
        </div>
      )}

      {/* Notification */}
      {notification && (
        <div style={{
          ...styles.notification,
          background: notification.type === "error" ? "#E8A0B0" : "#A6B49E",
          color: notification.type === "error" ? "#7A1C3E" : "#1A3530",
        }}>
          {notification.msg}
        </div>
      )}

      {/* Modal */}
      {modal === "addExpense" && (
        <AddExpenseModal onSave={handleAddExpense} onClose={() => setModal(null)} user={user} />
      )}
      {editingExpense && (
        <EditExpenseModal
          expense={editingExpense}
          onSave={handleEditExpense}
          onDelete={realUser === "emma" ? (id) => { handleDeleteExpense(id); setEditingExpense(null); } : undefined}
          onClose={() => setEditingExpense(null)}
        />
      )}
      {modal === "logPayment" && (
        <LogPaymentModal
          balance={balance}
          onSave={handleLogPayment}
          onClose={() => { setModal(null); setPaymentDraftKey("general"); setPaymentDraftAmount(null); }}
          user={user}
          targets={paymentTargets}
          planSummaries={planSummaries}
          targetSummaries={targetSummaries}
          initialAppliedToKey={paymentDraftKey}
          initialAmount={paymentDraftAmount}
        />
      )}

      {modal === "camQuickPay" && (
        <CamQuickPayModal
          expenses={expenses}
          targetSummaries={targetSummaries}
          onSubmit={handleLogPayment}
          onClose={() => setModal(null)}
        />
      )}

      {disputingExpense && (
        <DisputeModal
          expense={disputingExpense}
          onSubmit={handleLogPayment}
          onClose={() => setDisputingExpense(null)}
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
          onQuickPay={() => setModal("camQuickPay")}
          onConfirm={handleConfirm}
          onResolveDispute={handleResolveDispute}
          onRejectPayment={handleRejectPayment}
          onDismissRejectedPayment={handleDismissRejectedPayment}
          onDeleteExpense={handleDeleteExpense}
          onMarkPaid={handleMarkPaid}
          onNavigate={setScreen}
          onLogPaymentForKey={(key, amount) => {
            setPaymentDraftKey(key || "general");
            setPaymentDraftAmount(amount ?? null);
            setModal("logPayment");
          }}
          onDisputeExpense={(exp) => setDisputingExpense(exp)}
          onLogout={async () => { await signOut(auth); setScreen("dashboard"); }}
          onSwitchView={realUser === "emma" ? () => setViewAs(v => v === "cam" ? null : "cam") : null}
          viewingAsCam={viewAs === "cam"}
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
          onEditExpense={(exp) => setEditingExpense(exp)}
          onLogPaymentForKey={(key, amount) => {
            setPaymentDraftKey(key || "general");
            setPaymentDraftAmount(amount ?? null);
            setModal("logPayment");
          }}
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
    onEditExpense={(exp) => setEditingExpense(exp)}
    onMarkPaid={handleMarkPaid}
    targetSummaries={targetSummaries}
    onQuickAdd={handleAddExpense}
    onLogPaymentForKey={(key, amount) => {
      const nextKey = key || "general";
      setPaymentDraftKey(nextKey);
      setPaymentDraftAmount(amount ?? null);
      setModal("logPayment");
    }}
    onDisputeExpense={(exp) => setDisputingExpense(exp)}
  />
)}
      {screen === "urgent" && (
  <UrgentScreen
    expenses={urgentExpenses}
    user={user}
    onBack={() => setScreen("dashboard")}
    onMarkPaid={handleMarkPaid}
    onLogPaymentForKey={(key, amount) => {
      setPaymentDraftKey(key || "general");
      setPaymentDraftAmount(amount ?? null);
      setModal("logPayment");
    }}
  />
)}

      {/* Bottom Nav */}
      <BottomNav screen={screen} onNavigate={setScreen} urgentCount={urgentCount} hidden={modal !== null || editingExpense !== null} />
    </div>
  );
}

// ── LOGIN SCREEN ──────────────────────────────────────────────────────
function LoginScreen() {
  const [errMsg, setErrMsg] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleGoogleSignIn() {
    setErrMsg("");
    setLoading(true);
    try {
      if (Capacitor.isNativePlatform()) {
        // Native iOS: use Capacitor Firebase plugin for native Google Sign-In sheet
        const { FirebaseAuthentication } = await import("@capacitor-firebase/authentication");
        const result = await FirebaseAuthentication.signInWithGoogle();
        const credential = GoogleAuthProvider.credential(
          result.credential?.idToken,
          result.credential?.accessToken
        );
        await signInWithCredential(auth, credential);
      } else {
        // Web: use popup
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        await signInWithPopup(auth, provider);
      }
    } catch (err) {
      setErrMsg(err?.message || JSON.stringify(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.loginWrap}>
      <div style={styles.loginCard}>
        <div style={styles.loginLogo}>💸</div>
        <h1 style={styles.loginTitle}>SplitTrack</h1>
        <p style={styles.loginSubtitle}>Sign in to continue</p>
        <div style={styles.loginBtns}>
          <button
            style={{ ...styles.loginBtn, background: "linear-gradient(135deg, #A6B49E, #4E635E)", opacity: loading ? 0.6 : 1 }}
            onClick={handleGoogleSignIn}
            disabled={loading}
          >
            <span style={styles.loginBtnIcon}>🔐</span>
            <span>{loading ? "Signing in…" : "Sign in with Google"}</span>
            <span style={styles.loginBtnSub}>Secure</span>
          </button>
        </div>
        {errMsg ? (
          <p style={{ color: "#C0485A", fontSize: 13, marginTop: 12, wordBreak: "break-word", maxWidth: 280, textAlign: "center" }}>
            {errMsg}
          </p>
        ) : (
          <p style={styles.loginNote}>After signing in, access level is based on your email.</p>
        )}
      </div>
    </div>
  );
}

// ── DASHBOARD MOCKUP (incremental) ───────────────────────────────────
// Step 1: mockup components (not rendered yet)
// ── CAM REJECTED PAYMENTS CARD ────────────────────────────────────────
function CamRejectedCard({ payments = [], targetSummaries, onLogPaymentForKey, onDeletePayment }) {
  const rejected = payments.filter((p) => p.rejected && !p.confirmed);
  const [expandedId, setExpandedId] = useState(null);

  if (rejected.length === 0) return null;

  return (
    <div style={{ margin: "0 16px 16px", background: "#FFF8F0", borderRadius: 20, border: "1.5px solid #F5C4A0", boxShadow: "0 2px 12px rgba(200,80,0,0.08)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <Icon path={icons.flag} size={14} color="#E07A20" />
          <span style={{ fontSize: 13, fontWeight: 900, color: "#8B3A00" }}>Returned Payments</span>
        </div>
        <span style={{ fontSize: 10, fontWeight: 800, background: "#F5C4A0", color: "#8B3A00", borderRadius: 8, padding: "2px 8px" }}>
          {rejected.length} returned
        </span>
      </div>

      {rejected.map((p) => {
        const isOpen = expandedId === p.id;
        const suggKey = p.rejectionSuggestionKey;
        const suggLabel = suggKey && targetSummaries?.get(suggKey)?.label;
        return (
          <div key={p.id} style={{ borderTop: "1px solid #F0DDD0", margin: "0 10px 10px", borderRadius: 12, overflow: "hidden", border: "1.5px solid #F0DDD0", background: "#fff" }}>
            {/* Collapsed row */}
            <div
              role="button"
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", cursor: "pointer" }}
              onClick={() => setExpandedId(isOpen ? null : p.id)}
            >
              <div style={{ width: 32, height: 32, borderRadius: 10, background: "#FFF0E0", border: "1.5px solid #F5C4A0", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon path={icons.flag} size={14} color="#E07A20" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#1A1A1A" }}>
                  {p.method} · <span style={{ color: "#E07A20" }}>${Number(p.amount || 0).toFixed(2)}</span>
                </p>
                <p style={{ margin: "2px 0 0", fontSize: 11, color: "#AAA" }}>Emmanuella returned this payment</p>
              </div>
              <Icon path={isOpen ? icons.chevronUp : icons.chevronDown} size={13} color="#E07A20" />
            </div>

            {/* Expanded panel */}
            {isOpen && (
              <div style={{ padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                {/* Emma's message */}
                {p.rejectionReason && (
                  <div style={{ background: "#FFF0E0", borderRadius: 10, padding: "10px 12px", border: "1px solid #F5C4A0" }}>
                    <p style={{ margin: "0 0 3px", fontSize: 10, fontWeight: 800, color: "#E07A20", textTransform: "uppercase", letterSpacing: 0.5 }}>Emmanuella's note</p>
                    <p style={{ margin: 0, fontSize: 12, color: "#555", lineHeight: 1.5, fontStyle: "italic" }}>"{p.rejectionReason}"</p>
                  </div>
                )}

                {/* Suggestion */}
                {suggLabel && (
                  <div style={{ background: "#F0F5FF", borderRadius: 10, padding: "10px 12px", border: "1px solid #C0D0F0" }}>
                    <p style={{ margin: "0 0 3px", fontSize: 10, fontWeight: 800, color: "#3060B0", textTransform: "uppercase", letterSpacing: 0.5 }}>Suggested target</p>
                    <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "#00314B" }}>{suggLabel}</p>
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    style={{ flex: 1, background: "linear-gradient(135deg, #D5BD96, #7A9BB5)", color: "#fff", border: "none", borderRadius: 11, padding: "10px 0", fontSize: 12, fontWeight: 800, cursor: "pointer" }}
                    onClick={() => {
                      if (typeof onLogPaymentForKey === "function") {
                        onLogPaymentForKey(suggKey || "general", Number(p.amount || 0));
                      }
                    }}
                  >
                    {suggLabel ? `Pay → ${suggLabel}` : "Make New Payment"}
                  </button>
                  <button
                    type="button"
                    style={{ background: "#FFF0F2", color: "#C0485A", border: "1.5px solid #F5C4CD", borderRadius: 11, padding: "10px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                    onClick={() => typeof onDeletePayment === "function" && onDeletePayment(p.id)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DashboardPendingCard({ pendingPayments = [], onConfirm, onResolveDispute, onRejectPayment, user, targetSummaries, expenses = [] }) {
  if (user !== "emma") return null;

  const disputes = pendingPayments.filter(p => p.type === "dispute");
  const payments = pendingPayments.filter(p => p.type !== "dispute");
  const [expandedDispute, setExpandedDispute] = useState(null);
  const [expandedPayment, setExpandedPayment] = useState(null);
  const [decliningId, setDecliningId] = useState(null);
  const [declineInput, setDeclineInput] = useState("");
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectSuggKey, setRejectSuggKey] = useState("");

  function pendingTargetLabel(p) {
    const key = p.appliedToKey || (p.appliedToGroupId ? `grp:${p.appliedToGroupId}` : "general");
    if (!key || key === "general") return null;
    return targetSummaries?.get(key)?.label || null;
  }

  function relatedExpense(p) {
    const key = p.appliedToKey || (p.appliedToGroupId ? `grp:${p.appliedToGroupId}` : "general");
    if (!key || key === "general") return null;
    if (key.startsWith("exp:")) {
      const id = key.slice(4);
      return expenses.find(e => e.id === id) || null;
    }
    if (key.startsWith("grp:")) {
      const gid = key.slice(4);
      return expenses.find(e => (e.groupId || e.id) === gid) || null;
    }
    return null;
  }

  const [selectedIds, setSelectedIds] = useState(() => new Set((payments || []).map((p) => p.id)));

  // Keep selection in sync with payments only (not disputes)
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set();
      for (const p of payments) {
        if (prev.has(p.id) || prev.size === 0) next.add(p.id);
      }
      if (prev.size === 0) {
        for (const p of payments) next.add(p.id);
      }
      return next;
    });
  }, [pendingPayments]); // eslint-disable-line react-hooks/exhaustive-deps

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
        boxShadow: "0 4px 16px rgba(0,49,75,0.09)",
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
          {pendingPayments.length === 0 ? "0 pending" : `${payments.length} payment${payments.length !== 1 ? "s" : ""}${disputes.length > 0 ? `, ${disputes.length} dispute${disputes.length !== 1 ? "s" : ""}` : ""}`}
        </span>
      </div>

      {/* Scrollable list */}
      <div style={{ flex: 1, maxHeight: expandedPayment ? 340 : 160, overflowY: "auto", transition: "max-height 0.2s ease" }}>
        {pendingPayments.length === 0 ? (
          <div style={{ height: 112, display: "flex", alignItems: "center", justifyContent: "center", color: "#888", fontSize: 12, fontWeight: 700, textAlign: "center" }}>
            No Pending Activity
          </div>
        ) : (
          <>
            {/* Disputes — shown first with flag styling */}
            {disputes.map((p) => {
              const isExpanded = expandedDispute === p.id;
              return (
                <div key={p.id} style={{ borderRadius: 10, border: "1.5px solid #F8C4CD", background: "#FFF8F8", marginBottom: 6, overflow: "hidden" }}>
                  <div
                    style={{ display: "flex", alignItems: "center", padding: "7px 8px", gap: 7, cursor: "pointer" }}
                    role="button"
                    onClick={() => setExpandedDispute(isExpanded ? null : p.id)}
                  >
                    <div style={{ width: 22, height: 22, borderRadius: 7, background: "#FFF0F0", border: "1.5px solid #F8C4CD", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Icon path={icons.flag} size={12} color="#E05C6E" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: "#E05C6E", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        Dispute — {p.disputeDescription || "charge"}
                      </p>
                      <p style={{ fontSize: 9, color: "#bbb", margin: "1px 0 0" }}>{formatHistoryDate(p.date)} · Cam</p>
                    </div>
                    <Icon path={isExpanded ? icons.chevronUp : icons.chevronDown} size={12} color="#E05C6E" />
                  </div>
                  {isExpanded && (
                    <div style={{ padding: "0 8px 10px" }}>
                      <p style={{ fontSize: 11, color: "#555", margin: "0 0 8px", background: "#FFF0F0", borderRadius: 8, padding: "7px 10px", lineHeight: 1.5 }}>
                        <span style={{ fontWeight: 700, color: "#E05C6E" }}>Reason: </span>{p.disputeReason || "No reason provided"}
                      </p>

                      {/* Decline reason input — shown when dismissing */}
                      {decliningId === p.id ? (
                        <div style={{ marginBottom: 6 }}>
                          <textarea
                            autoFocus
                            placeholder="Explain why you're declining this dispute…"
                            value={declineInput}
                            onChange={ev => setDeclineInput(ev.target.value)}
                            rows={2}
                            style={{ width: "100%", padding: "8px 10px", borderRadius: 9, border: "1.5px solid #DDD5C5", fontSize: 11, fontFamily: "inherit", outline: "none", resize: "none", boxSizing: "border-box", marginBottom: 6, background: "#F5F1EB", color: "#0A1E2B" }}
                          />
                          <div style={{ display: "flex", gap: 6 }}>
                            <button type="button"
                              onClick={() => { setDecliningId(null); setDeclineInput(""); }}
                              style={{ flex: 1, padding: "7px 0", borderRadius: 9, border: "none", background: "#EDE7DC", color: "#888", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                              Cancel
                            </button>
                            <button type="button"
                              onClick={() => { onResolveDispute && onResolveDispute(p.id, "denied", declineInput.trim() || null); setExpandedDispute(null); setDecliningId(null); setDeclineInput(""); }}
                              style={{ flex: 1, padding: "7px 0", borderRadius: 9, border: "none", background: "#00314B", color: "#fff", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                              Send
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button type="button"
                            onClick={() => { onResolveDispute && onResolveDispute(p.id, "accepted"); setExpandedDispute(null); }}
                            style={{ flex: 1, padding: "7px 0", borderRadius: 9, border: "none", background: "linear-gradient(135deg, #A6B49E, #4E635E)", color: "#fff", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                            ✓ Accept
                          </button>
                          <button type="button"
                            onClick={() => { setDecliningId(p.id); setDeclineInput(""); }}
                            style={{ flex: 1, padding: "7px 0", borderRadius: 9, border: "none", background: "#EEE9E0", color: "#888", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                            Decline
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Regular payments */}
            {payments.map((p) => {
              const isOpen = expandedPayment === p.id;
              const tLabel = pendingTargetLabel(p);
              const exp    = relatedExpense(p);
              return (
                <div key={p.id} style={{ borderRadius: 10, border: isOpen ? "1.5px solid #E8C878" : "1.5px solid #F0EAE0", background: isOpen ? "#FFFBF0" : "#FAFAF8", marginBottom: 6, overflow: "hidden" }}>
                  {/* Collapsed header row */}
                  <div
                    style={{ display: "flex", alignItems: "center", padding: "8px 10px", gap: 8, cursor: "pointer" }}
                    role="button"
                    onClick={() => setExpandedPayment(isOpen ? null : p.id)}
                  >
                    <div
                      style={{ width: 20, height: 20, borderRadius: 7, flexShrink: 0, border: selectedIds.has(p.id) ? "1.5px solid #A6B49E" : "1.5px solid #d8eae7", background: selectedIds.has(p.id) ? "#A6B49E" : "#f5fffd", display: "flex", alignItems: "center", justifyContent: "center" }}
                      role="button"
                      onClick={(ev) => { ev.stopPropagation(); setSelectedIds((prev) => { const next = new Set(prev); if (next.has(p.id)) next.delete(p.id); else next.add(p.id); return next; }); }}
                    >
                      {selectedIds.has(p.id) && <Icon path={icons.check} size={12} color="#fff" />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: "#1e0f45", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {p.method || "Payment"} · <span style={{ color: "#2D5A4A" }}>${Number(p.amount || 0).toFixed(2)}</span>
                      </p>
                      <p style={{ fontSize: 9, color: "#bbb", margin: "1px 0 0" }}>{formatHistoryDate(p.date)} · Cam</p>
                    </div>
                    <Icon path={isOpen ? icons.chevronUp : icons.chevronDown} size={13} color="#C8A020" />
                  </div>

                  {/* Expanded detail panel */}
                  {isOpen && (
                    <div style={{ padding: "0 10px 10px" }}>
                      {/* Detail card */}
                      <div style={{ background: "#FFF8E8", borderRadius: 9, padding: "10px 12px", marginBottom: 10, display: "flex", flexDirection: "column", gap: 7 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: "#C48A00", textTransform: "uppercase", letterSpacing: 0.5 }}>Amount</span>
                          <span style={{ fontSize: 17, fontWeight: 900, color: "#00314B" }}>${Number(p.amount || 0).toFixed(2)}</span>
                        </div>
                        <div style={{ height: 1, background: "#F0E4B8" }} />
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontSize: 10, color: "#999", fontWeight: 600 }}>Method</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#1e0f45" }}>{p.method || "—"}</span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontSize: 10, color: "#999", fontWeight: 600 }}>Date</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#1e0f45" }}>{formatHistoryDate(p.date)}</span>
                        </div>
                        {tLabel && (
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span style={{ fontSize: 10, color: "#999", fontWeight: 600 }}>Applied to</span>
                            <span style={{ fontSize: 11, fontWeight: 700, color: "#1e0f45", textAlign: "right", maxWidth: "60%" }}>{tLabel}</span>
                          </div>
                        )}
                        {exp?.referenceNum && (
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span style={{ fontSize: 10, color: "#999", fontWeight: 600 }}>Ref #</span>
                            <span style={{ fontSize: 11, fontWeight: 700, color: "#1e0f45", fontFamily: "monospace" }}>{exp.referenceNum}</span>
                          </div>
                        )}
                        {p.note && (
                          <div>
                            <span style={{ fontSize: 10, color: "#999", fontWeight: 600 }}>Note</span>
                            <p style={{ fontSize: 11, color: "#555", margin: "3px 0 0", fontStyle: "italic", lineHeight: 1.4 }}>"{p.note}"</p>
                          </div>
                        )}
                      </div>
                      {/* Reject inline form */}
                      {rejectingId === p.id ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                          <textarea
                            autoFocus
                            placeholder="Reason for returning (e.g. wrong amount, apply to Electric instead)…"
                            value={rejectReason}
                            onChange={ev => setRejectReason(ev.target.value)}
                            rows={2}
                            style={{ width: "100%", padding: "8px 10px", borderRadius: 9, border: "1.5px solid #F5C4A0", fontSize: 11, fontFamily: "inherit", outline: "none", resize: "none", boxSizing: "border-box", background: "#FFF8F0", color: "#0A1E2B" }}
                          />
                          {/* Optional target suggestion */}
                          {targetSummaries && targetSummaries.size > 0 && (
                            <select
                              value={rejectSuggKey}
                              onChange={ev => setRejectSuggKey(ev.target.value)}
                              style={{ width: "100%", padding: "7px 10px", borderRadius: 9, border: "1.5px solid #F5C4A0", fontSize: 11, background: "#FFF8F0", color: "#0A1E2B", outline: "none", fontFamily: "inherit" }}
                            >
                              <option value="">— No target suggestion —</option>
                              {Array.from(targetSummaries.values()).map(t => (
                                <option key={t.key} value={t.key}>{t.label}</option>
                              ))}
                            </select>
                          )}
                          <div style={{ display: "flex", gap: 6 }}>
                            <button type="button"
                              onClick={() => { setRejectingId(null); setRejectReason(""); setRejectSuggKey(""); }}
                              style={{ flex: 1, padding: "8px 0", borderRadius: 9, border: "none", background: "#EDE7DC", color: "#888", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                              Cancel
                            </button>
                            <button type="button"
                              onClick={() => {
                                onRejectPayment && onRejectPayment(p.id, rejectReason.trim() || null, rejectSuggKey || null);
                                setRejectingId(null); setRejectReason(""); setRejectSuggKey(""); setExpandedPayment(null);
                              }}
                              style={{ flex: 1, padding: "8px 0", borderRadius: 9, border: "none", background: "#E07A20", color: "#fff", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                              Return to Cameron
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            type="button"
                            style={{ flex: 1, background: "linear-gradient(135deg, #A6B49E, #4E635E)", border: "none", borderRadius: 9, padding: "9px 0", color: "#fff", fontSize: 12, fontWeight: 800, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
                            onClick={() => { setSelectedIds((prev) => { const next = new Set(prev); next.add(p.id); return next; }); onConfirm(p.id); setExpandedPayment(null); }}
                          >
                            <Icon path={icons.check} size={13} color="#fff" /> Confirm
                          </button>
                          <button
                            type="button"
                            style={{ background: "#FFF0E0", color: "#E07A20", border: "1.5px solid #F5C4A0", borderRadius: 9, padding: "9px 12px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}
                            onClick={() => { setRejectingId(p.id); setRejectReason(""); setRejectSuggKey(""); }}
                          >
                            Return
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      {payments.length > 0 && (
        <button type="button"
          style={{ width: "100%", marginTop: 8, background: "linear-gradient(135deg, #A6B49E, #4E635E)", border: "none", borderRadius: 11, padding: 8, color: "#fff", fontSize: 11, fontWeight: 700, opacity: selectedCount === 0 ? 0.55 : 1, cursor: selectedCount === 0 ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
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


function DashboardRecentChargesList({ items = [], onOpenTarget, user, searching = false }) {
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
        maxHeight: searching ? "none" : 220,
        overflowY: searching ? "visible" : "auto",
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
            ? "#A6B49E"
            : dashUrgency === "overdue"
              ? "#E05C6E"
              : "#C06A8A";
        const dashStatusWidth =
          e.status === "paid" || youIsCredit ? "100%" : dashUrgency === "overdue" ? "85%" : "55%";
        const dashStatusBg =
          e.status === "paid" || youIsCredit
            ? "#EBF0E8"
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
              border: "1px solid #EDE7DC",
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
                  color: "#00314B",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {e.mandatory && (
                  <span title="Mandatory" style={{ display: "inline-block", marginRight: 5, verticalAlign: "middle" }}>
                    <svg width={11} height={11} viewBox="0 0 24 24" fill="#E05C6E" style={{ display: "block" }}>
                      <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
                    </svg>
                  </span>
                )}
                {e.description}
              </p>
              <p style={{ margin: "3px 0 0", fontSize: 11, color: "#999" }}>
  {user === "cam"
    ? `${e.account} · ${e.category}`
    : `${metaLeft} · ${e.account}`}
</p>
            </div>

            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "#00314B" }}>
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
        ? "#2D5A4A"
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
              <Icon path={icons.forward} size={18} color="#D5BD96" />
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── PAYMENT SCHEDULE HELPERS & COMPONENTS ─────────────────────────────
function getScheduleExpenses(expenses) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizonDate = new Date(today);
  horizonDate.setMonth(horizonDate.getMonth() + 6); // show 6 months ahead

  const results = [];

  (expenses || []).forEach(e => {
    if (e.status === "paid") return;
    if (!["cam", "split"].includes(e.split)) return;
    const baseDue = e.nextDue || e.dueDate;
    if (!baseDue) return;

    const amount = e.split === "split" ? Number(e.amount || 0) / 2 : Number(e.amount || 0);
    const isRecurring = e.recurring && e.recurring !== "none";

    // Always include the base upcoming date
    const baseDate = new Date(baseDue + "T12:00:00");
    if (baseDate >= today) {
      results.push({ ...e, _dueDate: baseDate, _amount: amount });
    }

    // For recurring expenses, project future occurrences within horizon
    if (isRecurring) {
      let nextDueStr = getNextDueDate(baseDue, e.recurring);
      for (let i = 0; i < 24; i++) {
        const d = new Date(nextDueStr + "T12:00:00");
        if (d > horizonDate) break;
        results.push({ ...e, _dueDate: d, _amount: amount, _projected: true });
        nextDueStr = getNextDueDate(nextDueStr, e.recurring);
      }
    }
  });

  return results.sort((a, b) => a._dueDate - b._dueDate);
}

function ScheduleMiniPreview({ expenses, onViewFull, accentColor = "#C5D9C2" }) {
  const scheduled = getScheduleExpenses(expenses);
  if (!scheduled.length) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = today.toISOString().split("T")[0];

  const days = Array.from({ length: 10 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const key = d.toISOString().split("T")[0];
    const total = scheduled.filter(e => e._dueDate.toISOString().split("T")[0] === key).reduce((s, e) => s + e._amount, 0);
    return { date: d, key, total };
  });

  const next = scheduled[0];
  const nextDateLabel = next._dueDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div style={{ padding: "0 20px 4px" }} onClick={(ev) => ev.stopPropagation()}>
      {/* Next Payment */}
      <p style={{ margin: "14px 0 8px", fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.6 }}>Next Payment</p>
      <div style={{ background: "rgba(255,255,255,0.1)", borderRadius: 12, padding: "11px 14px", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "#fff" }}>{nextDateLabel} · ${next._amount % 1 === 0 ? next._amount.toFixed(0) : next._amount.toFixed(2)}</p>
          <p style={{ margin: "3px 0 0", fontSize: 12, color: "rgba(255,255,255,0.6)", fontWeight: 500 }}>{next.description}</p>
        </div>
        <div style={{ width: 8, height: 8, borderRadius: 999, background: accentColor, flexShrink: 0 }} />
      </div>

      {/* Mini day strip */}
      <div style={{ display: "flex", gap: 5, overflowX: "auto", paddingBottom: 6, scrollbarWidth: "none", msOverflowStyle: "none", WebkitOverflowScrolling: "touch" }}>
        {days.map(({ date, key, total }) => {
          const isToday = key === todayKey;
          const has = total > 0;
          return (
            <div key={key} style={{ flexShrink: 0, width: 42, minHeight: 54, borderRadius: 10, padding: "7px 4px 5px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, background: has ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.07)", border: isToday ? "1.5px solid rgba(255,255,255,0.45)" : "1px solid transparent", transition: "background 0.2s" }}>
              <span style={{ fontSize: 13, fontWeight: isToday ? 900 : 600, color: isToday ? "#fff" : "rgba(255,255,255,0.65)" }}>{date.getDate()}</span>
              {has && <span style={{ fontSize: 9, fontWeight: 800, color: accentColor, lineHeight: 1 }}>${total >= 100 ? Math.round(total) : total.toFixed(0)}</span>}
            </div>
          );
        })}
      </div>

      {/* View full */}
      <button type="button" onClick={onViewFull} style={{ marginTop: 10, width: "100%", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 10, padding: "9px", fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.8)", cursor: "pointer", letterSpacing: 0.2 }}>
        View full schedule →
      </button>
    </div>
  );
}

function FullCalendarSheet({ expenses, onClose }) {
  const [selectedDate, setSelectedDate] = useState(null);
  const [currentMonth, setCurrentMonth] = useState(() => new Date());

  const scheduled = getScheduleExpenses(expenses);

  // Build a map: dateKey → [expenses]
  const dateMap = new Map();
  scheduled.forEach(e => {
    const key = e._dueDate.toISOString().split("T")[0];
    if (!dateMap.has(key)) dateMap.set(key, []);
    dateMap.get(key).push(e);
  });

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const monthName = currentMonth.toLocaleString("en-US", { month: "long" });
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = new Date().toISOString().split("T")[0];

  // Mon-based offset
  let startOffset = new Date(year, month, 1).getDay() - 1;
  if (startOffset < 0) startOffset = 6;

  const cells = [
    ...Array(startOffset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => {
      const d = i + 1;
      const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      return { d, key, exps: dateMap.get(key) || [] };
    }),
  ];

  const selectedExps = selectedDate ? (dateMap.get(selectedDate) || []) : [];
  const selectedDisplay = selectedDate
    ? new Date(selectedDate + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" })
    : "";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      style={{ position: "fixed", inset: 0, zIndex: 600, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
      onClick={() => selectedDate ? setSelectedDate(null) : onClose()}
    >
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        style={{ background: "#fff", borderRadius: "24px 24px 0 0", width: "100%", maxWidth: 430, maxHeight: "88vh", overflowY: "auto", paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 20px)" }}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div style={{ width: 40, height: 4, borderRadius: 999, background: "#DDD5C5", margin: "12px auto 0" }} />

        {/* Month nav */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px 6px" }}>
          <button type="button" onClick={() => setCurrentMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))} style={{ width: 36, height: 36, borderRadius: 999, border: "none", background: "#EEE9E0", cursor: "pointer", fontSize: 18, color: "#00314B", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>‹</button>
          <p style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "#00314B" }}>{monthName} {year}</p>
          <button type="button" onClick={() => setCurrentMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))} style={{ width: 36, height: 36, borderRadius: 999, border: "none", background: "#EEE9E0", cursor: "pointer", fontSize: 18, color: "#00314B", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>›</button>
        </div>

        {/* Day labels */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", padding: "0 12px", marginBottom: 2 }}>
          {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
            <div key={i} style={{ textAlign: "center", fontSize: 11, fontWeight: 700, color: "#CCC", padding: "2px 0 4px" }}>{d}</div>
          ))}
        </div>

        {/* Grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", padding: "0 12px", gap: 3 }}>
          {cells.map((cell, i) => {
            if (!cell) return <div key={`e${i}`} />;
            const { d, key, exps } = cell;
            const total = exps.reduce((s, e) => s + e._amount, 0);
            const has = exps.length > 0;
            const isToday = key === todayKey;
            const isSel = selectedDate === key;
            return (
              <div
                key={key}
                onClick={() => has && setSelectedDate(isSel ? null : key)}
                style={{ textAlign: "center", padding: "6px 2px", borderRadius: 10, minHeight: 52, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, background: isSel ? "#00314B" : isToday ? "#EEE9E0" : "transparent", cursor: has ? "pointer" : "default", transition: "background 0.15s" }}
              >
                <span style={{ fontSize: 14, fontWeight: isToday || isSel ? 800 : 400, color: isSel ? "#fff" : isToday ? "#00314B" : "#1A1A1A" }}>{d}</span>
                {has && <span style={{ fontSize: 9, fontWeight: 800, color: isSel ? "#C5D9C2" : "#A6B49E" }}>${total >= 100 ? Math.round(total) : total.toFixed(0)}</span>}
                {has && <div style={{ width: 4, height: 4, borderRadius: 999, background: isSel ? "#C5D9C2" : "#A6B49E" }} />}
              </div>
            );
          })}
        </div>

        {/* Selected date detail */}
        <AnimatePresence>
          {selectedDate && (
            <motion.div
              key={selectedDate}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 28 }}
              style={{ overflow: "hidden" }}
            >
              <div style={{ margin: "14px 16px 0", background: "#F2EDE4", borderRadius: 16, padding: "16px" }}>
                <p style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 800, color: "#00314B" }}>{selectedDisplay}</p>
                {selectedExps.map((e, i) => (
                  <div key={(e.id || i) + String(e._dueDate)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: i > 0 ? 10 : 0, borderTop: i > 0 ? "1px solid #EDE4F5" : "none" }}>
                    <div>
                      <span style={{ fontSize: 13, color: "#444", fontWeight: 600 }}>{e.description}</span>
                      {e._projected && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "#A6B7CB", background: "#EDE4F5", borderRadius: 4, padding: "1px 5px" }}>recurring</span>}
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 800, color: "#00314B" }}>${e._amount.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <button style={{ margin: "16px 16px 4px", width: "calc(100% - 32px)", padding: "13px", borderRadius: 14, border: "none", background: "#00314B", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }} onClick={onClose}>
          Close
        </button>
      </motion.div>
    </motion.div>
  );
}

// ── EMMA BALANCE BANNER ───────────────────────────────────────────────
function EmmaBalanceBanner({ balance, totalOwed, totalPaid, camOwesThisMonth, emmaPaidThisMonth, expenses = [], payments = [], onAddExpense, onLogPayment }) {
  const [expanded, setExpanded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const pct = totalOwed > 0 ? Math.min(1, totalPaid / totalOwed) : 0;
  const pctLabel = Math.round(pct * 100);

  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const monthName = now.toLocaleString("en-US", { month: "long" });
  const thisMonthExp = expenses.filter(e => String(e.date || "").startsWith(monthKey));
  const totalThisMonth = thisMonthExp.reduce((s, e) => s + Number(e.amount || 0), 0);
  const camUnpaid = expenses
    .filter(e => e.status !== "paid" && ["cam", "split"].includes(e.split))
    .reduce((s, e) => s + (e.split === "split" ? Number(e.amount || 0) / 2 : Number(e.amount || 0)), 0);
  const confirmedPayments = payments.filter(p => p?.confirmed);

  const circleActions = [
    { label: "Add\nExpense", icon: icons.plus, onTap: onAddExpense },
    { label: "Log\nPayment", icon: icons.wallet, onTap: onLogPayment },
    { label: "Details", icon: icons.list, onTap: () => setDetailsOpen(true) },
  ];

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: "easeOut" }}
        style={{
          margin: "0 16px",
          borderRadius: 24,
          background: "linear-gradient(145deg, #00314B 0%, #4E635E 45%, #A6B49E 100%)",
          boxShadow: "0 14px 40px rgba(119,161,120,0.35)",
          overflow: "hidden",
          cursor: "pointer",
        }}
        onClick={() => setExpanded((o) => !o)}
        role="button"
      >
        {/* Top section */}
        <div style={{ padding: "20px 20px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.65)", letterSpacing: 0.6, textTransform: "uppercase" }}>
              Cameron owes you
            </p>
            <Icon path={expanded ? icons.chevronUp : icons.chevronDown} size={16} color="rgba(255,255,255,0.6)" />
          </div>

          <p style={{ margin: "0 0 16px", fontSize: 38, fontWeight: 900, color: "#fff", letterSpacing: -1.5, lineHeight: 1 }}>
            ${balance.toFixed(2)}
          </p>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.65)", fontWeight: 600 }}>
                Paid ${totalPaid.toFixed(2)} of ${totalOwed.toFixed(2)}
              </span>
              <span style={{ fontSize: 11, color: "#d4f5d6", fontWeight: 800 }}>{pctLabel}%</span>
            </div>
            <div style={{ height: 7, borderRadius: 999, background: "rgba(255,255,255,0.18)", overflow: "hidden" }}>
              <div style={{ width: `${pctLabel}%`, height: "100%", background: "linear-gradient(90deg, #d4f5d6, #A6B49E)", borderRadius: 999, transition: "width 0.5s" }} />
            </div>
          </div>
        </div>

        {/* Expanded breakdown */}
        <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="emma-breakdown"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 28, opacity: { duration: 0.15 } }}
            style={{ overflow: "hidden" }}
          >
          <div style={{ padding: "12px 20px 16px", borderTop: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.12)" }}>
            <p style={{ margin: "0 0 10px", fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.6 }}>This Month</p>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
              <span style={{ fontSize: 13, color: "rgba(255,255,255,0.75)" }}>Cam owes this month</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>${Number(camOwesThisMonth || 0).toFixed(2)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
              <span style={{ fontSize: 13, color: "rgba(255,255,255,0.75)" }}>Your expenses this month</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#d4f5d6" }}>${Number(emmaPaidThisMonth || 0).toFixed(2)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13, color: "rgba(255,255,255,0.75)" }}>Remaining balance</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: "#fff" }}>${balance.toFixed(2)}</span>
            </div>
            <ScheduleMiniPreview expenses={expenses} onViewFull={() => setScheduleOpen(true)} accentColor="#d4f5d6" />
          </div>
          </motion.div>
        )}
        </AnimatePresence>

        {/* Circle action buttons */}
        <div
          style={{ display: "flex", justifyContent: "space-around", padding: "14px 20px 20px", borderTop: "1px solid rgba(255,255,255,0.1)" }}
          onClick={(ev) => ev.stopPropagation()}
        >
          {circleActions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => action.onTap && action.onTap()}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7, background: "none", border: "none", cursor: "pointer", padding: 0, flex: 1 }}
            >
              <div style={{
                width: 52, height: 52, borderRadius: 999,
                background: "rgba(255,255,255,0.18)",
                border: "1.5px solid rgba(255,255,255,0.3)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Icon path={action.icon} size={20} color="#fff" />
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.8)", textAlign: "center", lineHeight: 1.3, whiteSpace: "pre-line" }}>
                {action.label}
              </span>
            </button>
          ))}
        </div>
      </motion.div>

      {/* Details bottom sheet */}
      {detailsOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
          onClick={() => setDetailsOpen(false)}>
          <div style={{ background: "#fff", borderRadius: "24px 24px 0 0", padding: "24px 20px 44px", width: "100%", maxWidth: 430, maxHeight: "80vh", overflowY: "auto" }}
            onClick={(ev) => ev.stopPropagation()}>

            <div style={{ width: 40, height: 4, borderRadius: 999, background: "#DDD5C5", margin: "0 auto 20px" }} />

            <p style={{ margin: "0 0 18px", fontSize: 18, fontWeight: 900, color: "#00314B" }}>{monthName} Details</p>

            {/* Monthly summary */}
            <div style={{ background: "#F3FAF3", borderRadius: 16, padding: "16px", marginBottom: 12 }}>
              <p style={{ margin: "0 0 12px", fontSize: 11, fontWeight: 800, color: "#4E635E", textTransform: "uppercase", letterSpacing: 0.5 }}>This Month</p>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: "#555" }}>Total charges</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#00314B" }}>${totalThisMonth.toFixed(2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: "#555" }}>Cam owes this month</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#E05C6E" }}>${Number(camOwesThisMonth || 0).toFixed(2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13, color: "#555" }}>Your expenses this month</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#00314B" }}>${Number(emmaPaidThisMonth || 0).toFixed(2)}</span>
              </div>
            </div>

            {/* Insights */}
            <div style={{ background: "#F3FAF3", borderRadius: 16, padding: "16px", marginBottom: 12 }}>
              <p style={{ margin: "0 0 12px", fontSize: 11, fontWeight: 800, color: "#4E635E", textTransform: "uppercase", letterSpacing: 0.5 }}>Insights</p>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: "#555" }}>Cam still owes (total)</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#E05C6E" }}>${camUnpaid.toFixed(2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: "#555" }}>Total expenses on file</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#00314B" }}>{expenses.length} items</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13, color: "#555" }}>Confirmed payments</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#00314B" }}>{confirmedPayments.length}</span>
              </div>
            </div>

            {/* Overall progress */}
            <div style={{ background: "#F3FAF3", borderRadius: 16, padding: "16px", marginBottom: 16 }}>
              <p style={{ margin: "0 0 12px", fontSize: 11, fontWeight: 800, color: "#4E635E", textTransform: "uppercase", letterSpacing: 0.5 }}>Overall Progress</p>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 13, color: "#555" }}>Paid ${totalPaid.toFixed(2)} of ${totalOwed.toFixed(2)}</span>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#00314B" }}>{pctLabel}%</span>
              </div>
              <div style={{ height: 8, borderRadius: 999, background: "#d4f5d6", overflow: "hidden" }}>
                <div style={{ width: `${pctLabel}%`, height: "100%", background: "linear-gradient(90deg, #A6B49E, #00314B)", borderRadius: 999, transition: "width 0.4s" }} />
              </div>
            </div>

            <button
              style={{ width: "100%", padding: "13px", borderRadius: 14, border: "none", background: "#4E635E", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
              onClick={() => setDetailsOpen(false)}
            >Close</button>
          </div>
        </div>
      )}
      <AnimatePresence>{scheduleOpen && <FullCalendarSheet expenses={expenses} onClose={() => setScheduleOpen(false)} />}</AnimatePresence>
    </>
  );
}

// ── CAM BALANCE BANNER ────────────────────────────────────────────────
function CamBalanceBanner({ balance, totalOwed, totalPaid, camOwesThisMonth, camPaidThisMonth, overdueCount = 0, expenses = [], payments = [], onLogPayment, onQuickPay, onAddExpense, onNavigate, onDisputeExpense }) {
  const [expanded, setExpanded] = useState(false);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const pct = totalOwed > 0 ? Math.min(1, totalPaid / totalOwed) : 0;
  const pctLabel = Math.round(pct * 100);

  // Insights data
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const monthName = now.toLocaleString("en-US", { month: "long" });
  const thisMonthExp = expenses.filter(e => String(e.date || "").startsWith(monthKey));
  const totalThisMonth = thisMonthExp.reduce((s, e) => s + Number(e.amount || 0), 0);
  const camUnpaid = expenses
    .filter(e => e.status !== "paid" && ["cam", "split"].includes(e.split))
    .reduce((s, e) => s + (e.split === "split" ? Number(e.amount || 0) / 2 : Number(e.amount || 0)), 0);
  const confirmedPayments = payments.filter(p => p?.confirmed);

  const circleActions = [
    {
      label: "Quick\nPayment",
      icon: icons.wallet,
      bg: "rgba(255,255,255,0.18)",
      onTap: onQuickPay || onLogPayment,
    },
    {
      label: "Dispute",
      icon: icons.flag,
      bg: "rgba(255,255,255,0.18)",
      onTap: () => setDisputeOpen(true),
    },
    {
      label: "Add\nExpense",
      icon: icons.plus,
      bg: "rgba(255,255,255,0.18)",
      onTap: onAddExpense,
    },
    {
      label: "Details",
      icon: icons.list,
      bg: "rgba(255,255,255,0.18)",
      onTap: () => setDetailsOpen(true),
    },
  ];

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: "easeOut" }}
        style={{
          margin: "0 16px",
          borderRadius: 24,
          background: "linear-gradient(145deg, #00314B 0%, #1B4D6B 45%, #A6B7CB 100%)",
          boxShadow: "0 14px 40px rgba(50,121,168,0.35)",
          overflow: "hidden",
          cursor: "pointer",
        }}
        onClick={() => setExpanded((o) => !o)}
        role="button"
      >
        {/* ── Top section ── */}
        <div style={{ padding: "20px 20px 16px" }}>

          {/* Title row + overdue badge + chevron */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.65)", letterSpacing: 0.6, textTransform: "uppercase" }}>
              Your Current Balance
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {overdueCount > 0 && (
                <button
                  type="button"
                  onClick={(ev) => { ev.stopPropagation(); onNavigate("urgent"); }}
                  style={{ display: "flex", alignItems: "center", gap: 5, background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.3)", borderRadius: 20, padding: "3px 8px 3px 6px", cursor: "pointer" }}
                >
                  <Icon path={icons.fire} size={13} color="#FFD0A0" />
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#FFD0A0" }}>{overdueCount}</span>
                </button>
              )}
              <Icon path={expanded ? icons.chevronUp : icons.chevronDown} size={16} color="rgba(255,255,255,0.6)" />
            </div>
          </div>

          {/* Balance */}
          <p style={{ margin: "0 0 16px", fontSize: 38, fontWeight: 900, color: "#fff", letterSpacing: -1.5, lineHeight: 1 }}>
            ${balance.toFixed(2)}
          </p>

          {/* Progress bar */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.65)", fontWeight: 600 }}>
                Paid ${totalPaid.toFixed(2)} of ${totalOwed.toFixed(2)}
              </span>
              <span style={{ fontSize: 11, color: "#C5D9C2", fontWeight: 800 }}>{pctLabel}%</span>
            </div>
            <div style={{ height: 7, borderRadius: 999, background: "rgba(255,255,255,0.18)", overflow: "hidden" }}>
              <div style={{ width: `${pctLabel}%`, height: "100%", background: "linear-gradient(90deg, #C5D9C2, #7AAE96)", borderRadius: 999, transition: "width 0.5s" }} />
            </div>
          </div>
        </div>

        {/* ── Expanded breakdown ── */}
        <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="cam-breakdown"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 28, opacity: { duration: 0.15 } }}
            style={{ overflow: "hidden" }}
          >
          <div style={{ padding: "12px 20px 16px", borderTop: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.15)" }}>
            <p style={{ margin: "0 0 10px", fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.6 }}>This Month</p>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
              <span style={{ fontSize: 13, color: "rgba(255,255,255,0.75)" }}>Charges this month</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>${Number(camOwesThisMonth || 0).toFixed(2)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
              <span style={{ fontSize: 13, color: "rgba(255,255,255,0.75)" }}>Paid this month</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#C5D9C2" }}>${Number(camPaidThisMonth || 0).toFixed(2)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13, color: "rgba(255,255,255,0.75)" }}>Remaining balance</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: "#fff" }}>${balance.toFixed(2)}</span>
            </div>
            <ScheduleMiniPreview expenses={expenses} onViewFull={() => setScheduleOpen(true)} accentColor="#C5D9C2" />
          </div>
          </motion.div>
        )}
        </AnimatePresence>

        {/* ── Circle action buttons (inside card) ── */}
        <div
          style={{ display: "flex", justifyContent: "space-around", padding: "14px 20px 20px", borderTop: "1px solid rgba(255,255,255,0.1)" }}
          onClick={(ev) => ev.stopPropagation()}
        >
          {circleActions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => action.onTap && action.onTap()}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7, background: "none", border: "none", cursor: "pointer", padding: 0, flex: 1 }}
            >
              <div style={{
                width: 52,
                height: 52,
                borderRadius: 999,
                background: action.bg,
                border: "1.5px solid rgba(255,255,255,0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}>
                <Icon path={action.icon} size={20} color="#fff" />
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.8)", textAlign: "center", lineHeight: 1.3, whiteSpace: "pre-line" }}>
                {action.label}
              </span>
            </button>
          ))}
        </div>
      </motion.div>

      {/* Dispute bottom sheet — expense picker */}
      {disputeOpen && (() => {
        const disputeable = expenses
          .filter(e => e.status !== "paid" && (e.split === "cam" || e.split === "split"))
          .sort((a, b) => new Date(b.date) - new Date(a.date));
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
            onClick={() => setDisputeOpen(false)}>
            <div style={{ background: "#fff", borderRadius: "24px 24px 0 0", width: "100%", maxWidth: 430, maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 -8px 40px rgba(0,49,75,0.18)" }}
              onClick={ev => ev.stopPropagation()}>

              {/* Handle + header */}
              <div style={{ padding: "12px 20px 14px", borderBottom: "1px solid #EDE7DC", flexShrink: 0 }}>
                <div style={{ width: 40, height: 4, borderRadius: 2, background: "#DDD5C5", margin: "0 auto 14px" }} />
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 11, background: "#FFF0F0", border: "1.5px solid #F8C4CD", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon path={icons.flag} size={16} color="#E05C6E" />
                  </div>
                  <div>
                    <p style={{ margin: 0, fontSize: 17, fontWeight: 900, color: "#0A1E2B" }}>Dispute a Charge</p>
                    <p style={{ margin: 0, fontSize: 12, color: "#999" }}>Pick the expense you want to flag</p>
                  </div>
                </div>
              </div>

              {/* Scrollable expense list */}
              <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px 32px" }}>
                {disputeable.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "40px 20px", color: "#AAA" }}>
                    <p style={{ fontSize: 28, margin: "0 0 8px" }}>🎉</p>
                    <p style={{ fontSize: 14, fontWeight: 700, color: "#00314B", margin: "0 0 4px" }}>Nothing to dispute</p>
                    <p style={{ fontSize: 12, margin: 0 }}>All charges look good!</p>
                  </div>
                ) : (
                  disputeable.map(exp => {
                    const camShare = exp.split === "cam" ? Number(exp.amount) : Number(exp.amount) / 2;
                    const due = exp.nextDue || exp.dueDate || exp.date;
                    return (
                      <button
                        key={exp.id}
                        type="button"
                        onClick={() => { setDisputeOpen(false); onDisputeExpense && onDisputeExpense(exp); }}
                        style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 16, border: "1.5px solid #EDE7DC", background: "#FAFAF8", marginBottom: 8, cursor: "pointer", textAlign: "left" }}
                      >
                        <div style={{ width: 38, height: 38, borderRadius: 12, background: "#FFF0F2", border: "1.5px solid #F8C4CD", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          <Icon path={icons.list} size={16} color="#E05C6E" />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#0A1E2B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{exp.description}</p>
                          <p style={{ margin: "2px 0 0", fontSize: 11, color: "#AAA" }}>
                            {exp.category && <span>{exp.category} · </span>}
                            {due ? formatShortDate(due) : exp.date}
                          </p>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <p style={{ margin: 0, fontSize: 15, fontWeight: 900, color: "#E05C6E" }}>${camShare.toFixed(2)}</p>
                          <p style={{ margin: "2px 0 0", fontSize: 10, color: "#AAA", fontWeight: 600 }}>your share</p>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Details bottom sheet */}
      {detailsOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
          onClick={() => setDetailsOpen(false)}>
          <div style={{ background: "#fff", borderRadius: "24px 24px 0 0", padding: "24px 20px 44px", width: "100%", maxWidth: 430, maxHeight: "80vh", overflowY: "auto" }}
            onClick={(ev) => ev.stopPropagation()}>

            {/* Handle */}
            <div style={{ width: 40, height: 4, borderRadius: 999, background: "#DDD5C5", margin: "0 auto 20px" }} />

            <p style={{ margin: "0 0 18px", fontSize: 18, fontWeight: 900, color: "#00314B" }}>{monthName} Details</p>

            {/* Monthly summary */}
            <div style={{ background: "#F2EDE4", borderRadius: 16, padding: "16px", marginBottom: 12 }}>
              <p style={{ margin: "0 0 12px", fontSize: 11, fontWeight: 800, color: "#A6B7CB", textTransform: "uppercase", letterSpacing: 0.5 }}>This Month</p>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: "#555" }}>Total charges</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#00314B" }}>${totalThisMonth.toFixed(2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: "#555" }}>You owe this month</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#E05C6E" }}>${camOwesThisMonth.toFixed(2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13, color: "#555" }}>Paid this month</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#2D5A4A" }}>${camPaidThisMonth.toFixed(2)}</span>
              </div>
            </div>

            {/* Insights */}
            <div style={{ background: "#F2EDE4", borderRadius: 16, padding: "16px", marginBottom: 12 }}>
              <p style={{ margin: "0 0 12px", fontSize: 11, fontWeight: 800, color: "#A6B7CB", textTransform: "uppercase", letterSpacing: 0.5 }}>Insights</p>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: "#555" }}>Total still owed</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#E05C6E" }}>${camUnpaid.toFixed(2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: "#555" }}>Total expenses on file</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#00314B" }}>{expenses.length} items</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13, color: "#555" }}>Confirmed payments</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#00314B" }}>{confirmedPayments.length}</span>
              </div>
            </div>

            {/* Overall progress */}
            <div style={{ background: "#F2EDE4", borderRadius: 16, padding: "16px" }}>
              <p style={{ margin: "0 0 12px", fontSize: 11, fontWeight: 800, color: "#A6B7CB", textTransform: "uppercase", letterSpacing: 0.5 }}>Overall Progress</p>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 13, color: "#555" }}>Paid ${totalPaid.toFixed(2)} of ${totalOwed.toFixed(2)}</span>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#2D5A4A" }}>{pctLabel}%</span>
              </div>
              <div style={{ height: 8, borderRadius: 999, background: "#DDD5C5", overflow: "hidden" }}>
                <div style={{ width: `${pctLabel}%`, height: "100%", background: "linear-gradient(90deg, #A6B49E, #2D5A4A)", borderRadius: 999, transition: "width 0.4s" }} />
              </div>
            </div>

            <button
              style={{ marginTop: 16, width: "100%", padding: "13px", borderRadius: 14, border: "none", background: "#00314B", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
              onClick={() => setDetailsOpen(false)}
            >Close</button>
          </div>
        </div>
      )}
      <AnimatePresence>{scheduleOpen && <FullCalendarSheet expenses={expenses} onClose={() => setScheduleOpen(false)} />}</AnimatePresence>
    </>
  );
}

// ── DISPUTE MODAL ─────────────────────────────────────────────────────
const DISPUTE_REASONS = [
  "Amount seems wrong",
  "I already paid this",
  "I don't recognize this charge",
  "Split should be different",
  "This was cancelled",
  "Other",
];

function DisputeModal({ expense, onSubmit, onClose }) {
  const [selectedReason, setSelectedReason] = useState(null);
  const [details, setDetails] = useState("");
  const canSubmit = selectedReason !== null && (selectedReason !== "Other" || details.trim().length > 0);

  const camShare = expense
    ? expense.split === "cam" ? Number(expense.amount) : Number(expense.amount) / 2
    : 0;

  function handleSubmit() {
    const reason = selectedReason === "Other" ? details.trim() : `${selectedReason}${details.trim() ? ` — ${details.trim()}` : ""}`;
    onSubmit({
      type: "dispute",
      amount: camShare,
      date: new Date().toISOString().slice(0, 10),
      method: "Dispute",
      appliedToKey: `exp:${expense.id}`,
      disputeReason: reason,
      disputeDescription: expense.description,
      confirmed: false,
      disputeStatus: "pending",
    });
    onClose();
  }

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 900 }} />
      <div style={{
        position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
        width: "100%", maxWidth: 430, background: "#fff", borderRadius: "24px 24px 0 0",
        zIndex: 901, paddingBottom: "max(28px, env(safe-area-inset-bottom))",
        maxHeight: "88vh", overflowY: "auto", boxShadow: "0 -8px 40px rgba(0,49,75,0.18)",
      }}>
        {/* Handle */}
        <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 4px" }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: "#DDD5C5" }} />
        </div>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "8px 20px 16px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <div style={{ width: 32, height: 32, borderRadius: 10, background: "#FFF0F0", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Icon path={icons.flag} size={16} color="#E05C6E" />
              </div>
              <p style={{ margin: 0, fontSize: 20, fontWeight: 900, color: "#0A1E2B" }}>Dispute Charge</p>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: "#999" }}>Let Emmanuella know there's an issue</p>
          </div>
          <button onClick={onClose} type="button"
            style={{ background: "#E0D8CC", border: "none", borderRadius: 10, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 18, fontWeight: 700, color: "#6B5B8E", flexShrink: 0 }}>
            ✕
          </button>
        </div>

        <div style={{ padding: "0 20px 24px" }}>
          {/* Charge summary */}
          {expense && (
            <div style={{ background: "linear-gradient(135deg, #FFF5F6, #FFF0F0)", border: "1.5px solid #F8C4CD", borderRadius: 16, padding: "14px 16px", marginBottom: 20 }}>
              <p style={{ margin: "0 0 2px", fontSize: 12, color: "#E05C6E", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6 }}>Charge you're disputing</p>
              <p style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800, color: "#0A1E2B" }}>{expense.description}</p>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "#999" }}>{expense.date}</span>
                <span style={{ fontSize: 18, fontWeight: 900, color: "#E05C6E" }}>${camShare.toFixed(2)}</span>
              </div>
            </div>
          )}

          {/* Reason selection */}
          <p style={{ fontSize: 12, fontWeight: 800, color: "#999", textTransform: "uppercase", letterSpacing: 0.8, margin: "0 0 10px" }}>What's the issue?</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
            {DISPUTE_REASONS.map(r => (
              <button key={r} type="button"
                onClick={() => setSelectedReason(r)}
                style={{
                  padding: "13px 16px", borderRadius: 14, border: "2px solid",
                  borderColor: selectedReason === r ? "#E05C6E" : "#DDD5C5",
                  background: selectedReason === r ? "#FFF5F6" : "#F5F1EB",
                  color: selectedReason === r ? "#E05C6E" : "#555",
                  fontSize: 14, fontWeight: selectedReason === r ? 700 : 500,
                  cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between",
                }}>
                {r}
                {selectedReason === r && <Icon path={icons.check} size={16} color="#E05C6E" />}
              </button>
            ))}
          </div>

          {/* Details text area */}
          <p style={{ fontSize: 12, fontWeight: 800, color: "#999", textTransform: "uppercase", letterSpacing: 0.8, margin: "0 0 8px" }}>
            {selectedReason === "Other" ? "Explain the issue *" : "Additional details (optional)"}
          </p>
          <textarea
            placeholder="Add more context for Emmanuella…"
            value={details}
            onChange={e => setDetails(e.target.value)}
            rows={3}
            style={{
              width: "100%", padding: "12px 14px", borderRadius: 14, border: "1.5px solid #DDD5C5",
              fontSize: 14, color: "#0A1E2B", outline: "none", resize: "none",
              fontFamily: "inherit", background: "#F5F1EB", boxSizing: "border-box", marginBottom: 20,
            }}
          />

          <button type="button"
            disabled={!canSubmit}
            onClick={handleSubmit}
            style={{
              width: "100%", padding: "16px", borderRadius: 16, border: "none",
              background: canSubmit ? "linear-gradient(135deg, #E05C6E, #C0405A)" : "#DDD5C5",
              color: canSubmit ? "#fff" : "#AAA",
              fontSize: 16, fontWeight: 800, cursor: canSubmit ? "pointer" : "default",
            }}>
            Submit Dispute
          </button>
        </div>
      </div>
    </>
  );
}

// ── CAM QUICK PAY MODAL ───────────────────────────────────────────────
const PAYMENT_METHODS = ["Zelle", "Venmo", "Cash App", "Cash", "Apple Pay", "Other"];
const PRESET_AMOUNTS = [20, 50];

function CamQuickPayModal({ expenses = [], targetSummaries, onSubmit, onClose }) {
  const [step, setStep] = useState("amount"); // "amount" | "target" | "confirm"
  const [selectedAmt, setSelectedAmt] = useState(null); // 20 | 50 | "custom"
  const [customVal, setCustomVal] = useState("");
  const [targetMode, setTargetMode] = useState(null); // "overdue" | "specific"
  const [selectedExpIds, setSelectedExpIds] = useState(new Set());
  const [method, setMethod] = useState("Zelle");

  const finalAmount = selectedAmt === "custom" ? parseFloat(customVal) || 0 : (selectedAmt || 0);

  // Cameron's unpaid expenses he owes on
  const camUnpaid = (expenses || []).filter(e =>
    e.status !== "paid" && (e.split === "cam" || e.split === "split")
  );

  function camShare(e) {
    const amt = Number(e.amount || 0);
    return e.split === "cam" ? amt : amt / 2;
  }

  // Overdue sorted by cam's share ascending (clear smallest first)
  const overdueExps = camUnpaid
    .filter(e => getUrgencyLevel(e) === "overdue")
    .sort((a, b) => camShare(a) - camShare(b));

  // Preview: how the payment clears overdue balances
  function getOverduePlan(amt) {
    const plan = [];
    let left = amt;
    for (const e of overdueExps) {
      if (left <= 0.004) break;
      const share = camShare(e);
      const tKey = `exp:${e.id}`;
      const s = targetSummaries?.get(tKey);
      const tRem = s ? Math.max(0, Number(s.remaining ?? share)) : share;
      const pay = Math.min(tRem, left);
      if (pay > 0.004) { plan.push({ e, pay, tKey }); left -= pay; }
    }
    return plan;
  }

  const overduePlan = targetMode === "overdue" && finalAmount > 0 ? getOverduePlan(finalAmount) : [];

  // Multi-select helpers for "specific" mode
  const selectedExps = camUnpaid.filter(e => selectedExpIds.has(e.id));
  const selectedTotal = selectedExps.reduce((sum, e) => sum + camShare(e), 0);
  const remainingBudget = finalAmount - selectedTotal;

  function toggleExp(e) {
    const share = camShare(e);
    setSelectedExpIds(prev => {
      const next = new Set(prev);
      if (next.has(e.id)) {
        next.delete(e.id);
      } else if (share <= remainingBudget + 0.004) {
        next.add(e.id);
      }
      return next;
    });
  }

  const canProceedAmount = finalAmount > 0;
  const canConfirm = targetMode === "overdue"
    ? overduePlan.length > 0
    : targetMode === "specific" && selectedExpIds.size > 0;

  function handleConfirm() {
    const today = new Date().toISOString().slice(0, 10);
    if (targetMode === "overdue") {
      overduePlan.forEach(({ e, pay, tKey }) => {
        onSubmit({ amount: pay, date: today, method, appliedToKey: tKey, note: `Quick pay — clears overdue: ${e.description}` });
      });
    } else if (targetMode === "specific" && selectedExps.length > 0) {
      selectedExps.forEach(e => {
        const isRec = e.recurring && e.recurring !== "none";
        const tKey = isRec ? `grp:${e.groupId || e.id}` : `exp:${e.id}`;
        onSubmit({ amount: camShare(e), date: today, method, appliedToKey: tKey });
      });
    }
    onClose();
  }

  const sheetStyle = {
    position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
    width: "100%", maxWidth: 430, background: "#fff", borderRadius: "24px 24px 0 0",
    zIndex: 901, paddingBottom: "max(28px, env(safe-area-inset-bottom))",
    maxHeight: "88vh", overflowY: "auto", boxShadow: "0 -8px 40px rgba(0,49,75,0.18)",
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 900 }} />
      <div style={sheetStyle}>
        {/* Handle */}
        <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 4px" }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: "#DDD5C5" }} />
        </div>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 20px 16px" }}>
          <div>
            {step !== "amount" && (
              <button onClick={() => { if (step === "confirm") setStep("target"); else if (step === "target") setStep("amount"); }}
                style={{ background: "none", border: "none", color: "#A6B7CB", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 0, marginBottom: 2 }}>
                ← Back
              </button>
            )}
            <p style={{ margin: 0, fontSize: 20, fontWeight: 900, color: "#0A1E2B" }}>Quick Payment</p>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "#999" }}>
              {step === "amount" ? "How much are you paying?" : step === "target" ? "Where should it go?" : "Review & confirm"}
            </p>
          </div>
          <button onClick={onClose} type="button"
            style={{ background: "#E0D8CC", border: "none", borderRadius: 10, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 18, fontWeight: 700, color: "#6B5B8E", lineHeight: 1 }}>
            ✕
          </button>
        </div>

        {/* ── STEP 1: Amount ── */}
        {step === "amount" && (
          <div style={{ padding: "0 20px 24px" }}>
            {/* Preset chips */}
            <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
              {PRESET_AMOUNTS.map(amt => (
                <button key={amt} type="button"
                  onClick={() => { setSelectedAmt(amt); setCustomVal(""); }}
                  style={{
                    flex: 1, padding: "18px 0", borderRadius: 16, border: "2px solid",
                    borderColor: selectedAmt === amt ? "#00314B" : "#DDD5C5",
                    background: selectedAmt === amt ? "#00314B" : "#F5F1EB",
                    color: selectedAmt === amt ? "#fff" : "#00314B",
                    fontSize: 22, fontWeight: 900, cursor: "pointer", transition: "all 0.15s",
                  }}>
                  ${amt}
                </button>
              ))}
              <button type="button"
                onClick={() => setSelectedAmt("custom")}
                style={{
                  flex: 1, padding: "18px 0", borderRadius: 16, border: "2px solid",
                  borderColor: selectedAmt === "custom" ? "#A6B7CB" : "#DDD5C5",
                  background: selectedAmt === "custom" ? "#EEE9E0" : "#F5F1EB",
                  color: selectedAmt === "custom" ? "#A6B7CB" : "#888",
                  fontSize: 15, fontWeight: 800, cursor: "pointer", transition: "all 0.15s",
                }}>
                Custom
              </button>
            </div>

            {/* Custom amount input */}
            {selectedAmt === "custom" && (
              <div style={{ position: "relative", display: "flex", alignItems: "center", marginBottom: 16 }}>
                <span style={{ position: "absolute", left: 16, fontSize: 22, fontWeight: 900, color: "#00314B", pointerEvents: "none" }}>$</span>
                <input
                  autoFocus type="number" min="0.01" step="0.01" placeholder="0.00"
                  value={customVal}
                  onChange={e => setCustomVal(e.target.value)}
                  style={{ width: "100%", padding: "16px 16px 16px 36px", borderRadius: 14, border: "2px solid #D5BD96", fontSize: 22, fontWeight: 900, color: "#00314B", outline: "none", boxSizing: "border-box", background: "#F5F1EB" }}
                />
              </div>
            )}

            {/* Payment method */}
            <p style={{ fontSize: 12, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: 0.8, margin: "0 0 10px" }}>Payment Method</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}>
              {PAYMENT_METHODS.map(m => (
                <button key={m} type="button"
                  onClick={() => setMethod(m)}
                  style={{
                    padding: "7px 14px", borderRadius: 999, border: "1.5px solid",
                    borderColor: method === m ? "#00314B" : "#DDD5C5",
                    background: method === m ? "#00314B" : "#fff",
                    color: method === m ? "#fff" : "#888",
                    fontSize: 12, fontWeight: 700, cursor: "pointer",
                  }}>
                  {m}
                </button>
              ))}
            </div>

            <button type="button"
              disabled={!canProceedAmount}
              onClick={() => setStep("target")}
              style={{
                width: "100%", padding: "16px", borderRadius: 16, border: "none",
                background: canProceedAmount ? "linear-gradient(135deg, #00314B, #1B4D6B)" : "#DDD5C5",
                color: canProceedAmount ? "#fff" : "#AAA",
                fontSize: 16, fontWeight: 800, cursor: canProceedAmount ? "pointer" : "default",
              }}>
              Next →
            </button>
          </div>
        )}

        {/* ── STEP 2: Target ── */}
        {step === "target" && (
          <div style={{ padding: "0 20px 24px" }}>
            <div style={{ background: "#EEE9E0", borderRadius: 14, padding: "12px 16px", marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, color: "#888", fontWeight: 600 }}>Paying</span>
              <span style={{ fontSize: 20, fontWeight: 900, color: "#00314B" }}>${finalAmount.toFixed(2)} via {method}</span>
            </div>

            {/* Option A: Clear overdue */}
            <button type="button"
              onClick={() => { setTargetMode("overdue"); setSelectedExpIds(new Set()); }}
              style={{
                width: "100%", marginBottom: 12, padding: "16px", borderRadius: 16,
                border: "2px solid", borderColor: targetMode === "overdue" ? "#E05C6E" : "#DDD5C5",
                background: targetMode === "overdue" ? "#FFF5F6" : "#fff",
                textAlign: "left", cursor: "pointer",
              }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 12, background: targetMode === "overdue" ? "#E05C6E" : "#EEE9E0", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Icon path={icons.fire} size={18} color={targetMode === "overdue" ? "#fff" : "#E05C6E"} />
                </div>
                <div>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "#0A1E2B" }}>Clear overdue balances</p>
                  <p style={{ margin: "2px 0 0", fontSize: 11, color: "#888" }}>
                    {overdueExps.length > 0
                      ? `Clears ${overdueExps.length} overdue charge${overdueExps.length !== 1 ? "s" : ""}, smallest first`
                      : "No overdue charges right now"}
                  </p>
                </div>
              </div>
              {targetMode === "overdue" && overduePlan.length > 0 && (
                <div style={{ marginTop: 12, borderTop: "1px solid #F8E8EA", paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  {overduePlan.map(({ e, pay }) => (
                    <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 12, color: "#E05C6E", fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "70%" }}>{e.description}</span>
                      <span style={{ fontSize: 12, fontWeight: 800, color: "#E05C6E" }}>${pay.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
              {targetMode === "overdue" && overdueExps.length === 0 && (
                <p style={{ margin: "8px 0 0", fontSize: 11, color: "#E05C6E", fontWeight: 600 }}>No overdue charges to clear.</p>
              )}
            </button>

            {/* Option B: Specific transaction */}
            <button type="button"
              onClick={() => setTargetMode("specific")}
              style={{
                width: "100%", padding: "16px", borderRadius: 16,
                border: "2px solid", borderColor: targetMode === "specific" ? "#A6B7CB" : "#DDD5C5",
                background: targetMode === "specific" ? "#EEE9E0" : "#fff",
                textAlign: "left", cursor: "pointer", marginBottom: 16,
              }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 12, background: targetMode === "specific" ? "#A6B7CB" : "#EEE9E0", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Icon path={icons.list} size={18} color={targetMode === "specific" ? "#fff" : "#A6B7CB"} />
                </div>
                <div>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "#0A1E2B" }}>Specific transaction</p>
                  <p style={{ margin: "2px 0 0", fontSize: 11, color: "#888" }}>Choose which charge this goes toward</p>
                </div>
              </div>
            </button>

            {/* Transaction picker */}
            {targetMode === "specific" && (
              <div style={{ marginBottom: 16 }}>
                {/* Budget bar */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <p style={{ fontSize: 11, fontWeight: 800, color: "#999", textTransform: "uppercase", letterSpacing: 0.8, margin: 0 }}>Select charges</p>
                  <span style={{ fontSize: 12, fontWeight: 800, color: remainingBudget < 0.01 ? "#4E635E" : "#A6B7CB" }}>
                    ${selectedTotal.toFixed(2)} / ${finalAmount.toFixed(2)}
                  </span>
                </div>
                <div style={{ height: 5, borderRadius: 999, background: "#DDD5C5", overflow: "hidden", marginBottom: 12 }}>
                  <div style={{ height: "100%", borderRadius: 999, background: remainingBudget < 0.01 ? "#4E635E" : "#A6B7CB", width: `${Math.min(100, (selectedTotal / finalAmount) * 100)}%`, transition: "width 0.2s" }} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {camUnpaid.length === 0 && (
                    <p style={{ fontSize: 13, color: "#AAA", textAlign: "center", padding: "16px 0" }}>No unpaid charges found.</p>
                  )}
                  {camUnpaid.map(e => {
                    const share = camShare(e);
                    const isOverdue = getUrgencyLevel(e) === "overdue";
                    const isSelected = selectedExpIds.has(e.id);
                    const wouldExceed = !isSelected && share > remainingBudget + 0.004;
                    return (
                      <button key={e.id} type="button"
                        onClick={() => !wouldExceed && toggleExp(e)}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "12px 14px", borderRadius: 14, border: "2px solid",
                          borderColor: isSelected ? "#A6B7CB" : isOverdue ? "#F8C4CD" : "#DDD5C5",
                          background: isSelected ? "#EDE7DC" : wouldExceed ? "#F8F8F8" : isOverdue ? "#FFF8F8" : "#F5F1EB",
                          cursor: wouldExceed ? "not-allowed" : "pointer", textAlign: "left",
                          opacity: wouldExceed ? 0.45 : 1,
                        }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#0A1E2B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.description}</p>
                          <p style={{ margin: "2px 0 0", fontSize: 11, color: isOverdue ? "#E05C6E" : "#999", fontWeight: 600 }}>
                            {isOverdue ? "Overdue · " : ""}{formatShortDate(e.nextDue || e.dueDate || e.date)}
                          </p>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, marginLeft: 10 }}>
                          <span style={{ fontSize: 14, fontWeight: 800, color: isOverdue ? "#E05C6E" : "#00314B" }}>${share.toFixed(2)}</span>
                          {isSelected && <Icon path={icons.check} size={16} color="#A6B7CB" />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <button type="button"
              disabled={!canConfirm}
              onClick={() => canConfirm && setStep("confirm")}
              style={{
                width: "100%", padding: "16px", borderRadius: 16, border: "none",
                background: canConfirm ? "linear-gradient(135deg, #00314B, #1B4D6B)" : "#DDD5C5",
                color: canConfirm ? "#fff" : "#AAA",
                fontSize: 16, fontWeight: 800, cursor: canConfirm ? "pointer" : "default",
              }}>
              Review Payment →
            </button>
          </div>
        )}

        {/* ── STEP 3: Confirm ── */}
        {step === "confirm" && (
          <div style={{ padding: "0 20px 24px" }}>
            <div style={{ background: "linear-gradient(135deg, #00314B, #1B4D6B)", borderRadius: 20, padding: "20px", marginBottom: 20, color: "#fff" }}>
              <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 700, opacity: 0.7, textTransform: "uppercase", letterSpacing: 0.8 }}>You're paying</p>
              <p style={{ margin: "0 0 16px", fontSize: 34, fontWeight: 900 }}>${finalAmount.toFixed(2)}</p>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, opacity: 0.85 }}>
                <span>via {method}</span>
                <span>{targetMode === "overdue" ? `Clears ${overduePlan.length} overdue charge${overduePlan.length !== 1 ? "s" : ""}` : `${selectedExps.length} charge${selectedExps.length !== 1 ? "s" : ""} selected`}</span>
              </div>
            </div>

            {targetMode === "overdue" && overduePlan.length > 0 && (
              <div style={{ background: "#FFF5F6", borderRadius: 14, padding: "12px 16px", marginBottom: 20 }}>
                <p style={{ margin: "0 0 10px", fontSize: 11, fontWeight: 800, color: "#E05C6E", textTransform: "uppercase", letterSpacing: 0.8 }}>Breakdown</p>
                {overduePlan.map(({ e, pay }) => (
                  <div key={e.id} style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 13, color: "#0A1E2B", fontWeight: 600 }}>{e.description}</span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: "#E05C6E" }}>${pay.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}

            {targetMode === "specific" && selectedExps.length > 0 && (
              <div style={{ background: "#EEE9E0", borderRadius: 14, padding: "12px 16px", marginBottom: 20 }}>
                <p style={{ margin: "0 0 10px", fontSize: 11, fontWeight: 800, color: "#A6B7CB", textTransform: "uppercase", letterSpacing: 0.8 }}>Applied to</p>
                {selectedExps.map(e => (
                  <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#0A1E2B", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "70%" }}>{e.description}</span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: "#A6B7CB" }}>${camShare(e).toFixed(2)}</span>
                  </div>
                ))}
                {selectedExps.length > 1 && (
                  <div style={{ borderTop: "1px solid #DDD5C5", marginTop: 6, paddingTop: 6, display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: "#666" }}>Total</span>
                    <span style={{ fontSize: 13, fontWeight: 900, color: "#00314B" }}>${selectedTotal.toFixed(2)}</span>
                  </div>
                )}
              </div>
            )}

            <p style={{ fontSize: 12, color: "#AAA", textAlign: "center", margin: "0 0 16px", lineHeight: 1.5 }}>
              This payment will be pending until Emmanuella confirms it.
            </p>

            <button type="button" onClick={handleConfirm}
              style={{ width: "100%", padding: "16px", borderRadius: 16, border: "none", background: "linear-gradient(135deg, #A6B49E, #4E635E)", color: "#fff", fontSize: 16, fontWeight: 800, cursor: "pointer" }}>
              Confirm Payment ✓
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ── CAM NOTIFICATIONS PANEL ───────────────────────────────────────────
function CamNotificationsPanel({ expenses = [], payments = [], onClose, onNavigate }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Upcoming: Cameron's unpaid charges due within 14 days
  const upcoming = (expenses || [])
    .filter((e) => {
      if (e.status === "paid") return false;
      const camOwes = e.split === "cam" || e.split === "split";
      if (!camOwes) return false;
      const due = e.nextDue || e.dueDate;
      if (!due) return false;
      const dueD = new Date(due + "T12:00:00");
      const diffDays = Math.ceil((dueD - today) / 86400000);
      return diffDays <= 14;
    })
    .sort((a, b) => {
      // Mandatory overdue first, then mandatory upcoming, then by date
      const aOverdue = getUrgencyLevel(a) === "overdue";
      const bOverdue = getUrgencyLevel(b) === "overdue";
      if (a.mandatory && aOverdue && !(b.mandatory && bOverdue)) return -1;
      if (b.mandatory && bOverdue && !(a.mandatory && aOverdue)) return 1;
      if (a.mandatory && !b.mandatory) return -1;
      if (b.mandatory && !a.mandatory) return 1;
      const da = a.nextDue || a.dueDate;
      const db = b.nextDue || b.dueDate;
      return new Date(da) - new Date(db);
    });

  // Recently confirmed payments (last 7 days, non-dispute)
  const recentlyConfirmed = (payments || [])
    .filter((p) => {
      if (!p.confirmed || p.type === "dispute") return false;
      const pDate = new Date((p.date || "") + "T12:00:00");
      const diffDays = Math.ceil((today - pDate) / 86400000);
      return diffDays <= 7;
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  // Pending: payments awaiting confirmation (non-dispute)
  const pending = (payments || []).filter((p) => !p.confirmed && p.type !== "dispute");

  // Declined disputes (last 14 days) — show Emma's response
  const declinedDisputes = (payments || [])
    .filter((p) => p.type === "dispute" && p.confirmed && p.disputeStatus === "denied")
    .filter((p) => {
      const pDate = new Date((p.date || "") + "T12:00:00");
      return Math.ceil((today - pDate) / 86400000) <= 14;
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const hasAny = upcoming.length > 0 || recentlyConfirmed.length > 0 || pending.length > 0 || declinedDisputes.length > 0;

  function camAmt(e) {
    const amt = Number(e.amount || 0);
    if (e.split === "cam") return amt;
    if (e.split === "split") return amt / 2;
    return 0;
  }

  function dueLabel(e) {
    const due = e.nextDue || e.dueDate;
    if (!due) return "";
    const dueD = new Date(due + "T12:00:00");
    dueD.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil((dueD - today) / 86400000);
    const isOverdue = getUrgencyLevel(e) === "overdue";
    if (isOverdue) return "Overdue";
    if (diffDays === 0) return "Due today";
    if (diffDays === 1) return "Due tomorrow";
    return `Due in ${diffDays}d`;
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 800 }}
      />
      {/* Sheet */}
      <div style={{
        position: "fixed",
        bottom: 0,
        left: "50%",
        transform: "translateX(-50%)",
        width: "100%",
        maxWidth: 430,
        background: "#fff",
        borderRadius: "22px 22px 0 0",
        zIndex: 801,
        paddingBottom: "max(24px, env(safe-area-inset-bottom))",
        maxHeight: "75vh",
        overflowY: "auto",
      }}>
        {/* Handle */}
        <div style={{ display: "flex", justifyContent: "center", padding: "10px 0 6px" }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: "#DDD5C5" }} />
        </div>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 18px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon path={icons.bell} size={18} color="#E05C6E" />
            <span style={{ fontSize: 16, fontWeight: 800, color: "#0A1E2B" }}>Notifications</span>
          </div>
          <button
            onClick={onClose}
            type="button"
            style={{ background: "#EEE9E0", border: "none", borderRadius: 10, width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
          >
            <Icon path={icons.x} size={16} color="#888" />
          </button>
        </div>

        {!hasAny && (
          <div style={{ padding: "32px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🎉</div>
            <p style={{ fontSize: 15, fontWeight: 700, color: "#00314B", margin: "0 0 4px" }}>You're all caught up!</p>
            <p style={{ fontSize: 13, color: "#999", margin: 0 }}>No upcoming payments or pending activity.</p>
          </div>
        )}

        {/* Overdue / Upcoming */}
        {upcoming.length > 0 && (
          <div style={{ padding: "0 16px 4px" }}>
            <p style={{ fontSize: 11, fontWeight: 800, color: "#999", textTransform: "uppercase", letterSpacing: 0.8, margin: "0 0 8px" }}>Upcoming Payments</p>
            {upcoming.map((e) => {
              const overdue = getUrgencyLevel(e) === "overdue";
              const accentColor = e.mandatory && overdue ? "#C0192E" : overdue ? "#E05C6E" : e.mandatory ? "#C0192E" : "#A6B7CB";
              const bgColor = e.mandatory ? (overdue ? "#FFF0F2" : "#FFF5F6") : overdue ? "#FFF5F6" : "#F2EDE4";
              const borderColor = e.mandatory ? "#F8A0B0" : overdue ? "#F8C4CD" : "#E0D8CC";
              return (
                <div
                  key={e.id}
                  style={{ background: bgColor, borderRadius: 14, padding: "12px 14px", marginBottom: 8, border: `1.5px solid ${borderColor}`, cursor: "pointer" }}
                  onClick={() => { onNavigate("urgent"); onClose(); }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
                        {e.mandatory && (
                          <svg width={11} height={11} viewBox="0 0 24 24" fill={accentColor} style={{ flexShrink: 0 }}>
                            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
                          </svg>
                        )}
                        <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#0A1E2B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.description}</p>
                      </div>
                      <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: accentColor }}>
                        {e.mandatory && overdue ? "⚠ MANDATORY — Overdue" : e.mandatory ? "Mandatory · " + dueLabel(e) : dueLabel(e)}
                      </p>
                    </div>
                    <span style={{ fontSize: 15, fontWeight: 800, color: accentColor, flexShrink: 0, marginLeft: 10 }}>${camAmt(e).toFixed(2)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pending confirmation */}
        {pending.length > 0 && (
          <div style={{ padding: "8px 16px 4px" }}>
            <p style={{ fontSize: 11, fontWeight: 800, color: "#999", textTransform: "uppercase", letterSpacing: 0.8, margin: "0 0 8px" }}>Awaiting Confirmation</p>
            {pending.map((p, i) => (
              <div key={p.id || i} style={{ background: "#FFFBF0", borderRadius: 14, padding: "12px 14px", marginBottom: 8, border: "1.5px solid #F5E6B0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#0A1E2B" }}>Payment via {p.method || "—"}</p>
                    <p style={{ margin: "3px 0 0", fontSize: 11, fontWeight: 600, color: "#C48A00" }}>Pending · waiting for confirmation</p>
                  </div>
                  <span style={{ fontSize: 15, fontWeight: 800, color: "#C48A00" }}>${Number(p.amount || 0).toFixed(2)}</span>
                </div>
                {p.note && <p style={{ margin: "6px 0 0", fontSize: 12, color: "#888" }}>{p.note}</p>}
              </div>
            ))}
          </div>
        )}

        {/* Recently confirmed */}
        {recentlyConfirmed.length > 0 && (
          <div style={{ padding: "8px 16px 4px" }}>
            <p style={{ fontSize: 11, fontWeight: 800, color: "#999", textTransform: "uppercase", letterSpacing: 0.8, margin: "0 0 8px" }}>Recently Confirmed</p>
            {recentlyConfirmed.map((p, i) => (
              <div key={p.id || i} style={{ background: "#F0FFF6", borderRadius: 14, padding: "12px 14px", marginBottom: 8, border: "1.5px solid #C5D9C2" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#0A1E2B" }}>Payment confirmed</p>
                    <p style={{ margin: "3px 0 0", fontSize: 11, fontWeight: 600, color: "#2E9E60" }}>via {p.method || "—"} · {formatShortDate(p.date)}</p>
                  </div>
                  <span style={{ fontSize: 15, fontWeight: 800, color: "#2E9E60" }}>${Number(p.amount || 0).toFixed(2)}</span>
                </div>
                {p.note && <p style={{ margin: "6px 0 0", fontSize: 12, color: "#888" }}>{p.note}</p>}
              </div>
            ))}
          </div>
        )}

        {/* Declined disputes — Emma's response to Cameron */}
        {declinedDisputes.length > 0 && (
          <div style={{ padding: "8px 16px 4px" }}>
            <p style={{ fontSize: 11, fontWeight: 800, color: "#999", textTransform: "uppercase", letterSpacing: 0.8, margin: "0 0 8px" }}>Dispute Response</p>
            {declinedDisputes.map((p, i) => (
              <div key={p.id || i} style={{ background: "#FFF8F0", borderRadius: 14, padding: "12px 14px", marginBottom: 8, border: "1.5px solid #F5DABA" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <div style={{ width: 32, height: 32, borderRadius: 10, background: "#FFF0E0", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon path={icons.flag} size={16} color="#C48A00" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "#0A1E2B" }}>Dispute declined</p>
                    <p style={{ margin: "2px 0 4px", fontSize: 11, color: "#C48A00", fontWeight: 600 }}>
                      {p.disputeDescription || "charge"} · {formatShortDate(p.date)}
                    </p>
                    {p.declineReason ? (
                      <div style={{ background: "#FFF3E0", border: "1px solid #F5DABA", borderRadius: 9, padding: "8px 10px" }}>
                        <p style={{ margin: "0 0 2px", fontSize: 10, fontWeight: 800, color: "#C48A00", textTransform: "uppercase", letterSpacing: 0.5 }}>Emmanuella's response</p>
                        <p style={{ margin: 0, fontSize: 12, color: "#555", lineHeight: 1.5 }}>"{p.declineReason}"</p>
                      </div>
                    ) : (
                      <p style={{ margin: 0, fontSize: 12, color: "#999", fontStyle: "italic" }}>The charge stands — no additional reason given.</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ── PUSH NOTIFICATION ENABLE BANNER ───────────────────────────────────
function NotifEnableBanner({ user, notifPermission, setNotifPermission, setTokenSaved }) {
  const [msg, setMsg] = useState(null);

  async function handleEnable() {
    const { isSupported } = await import("firebase/messaging");
    const supported = await isSupported();
    if (!supported) {
      setMsg("Open the app from your Home Screen icon (not Safari) to enable notifications.");
      return;
    }
    const { initPushNotifications } = await import("./pushNotifications");
    await initPushNotifications(user);
    const perm = typeof Notification !== "undefined" ? Notification.permission : "granted";
    setNotifPermission(perm);
    if (perm === "granted") {
      setMsg(null);
      setTokenSaved(localStorage.getItem("fcmTokenSaved") === user);
    }
  }

  return (
    <div style={{ margin: "12px 16px 0", padding: "12px 16px", borderRadius: 14, background: "rgba(196,181,253,0.13)", border: "1px solid rgba(196,181,253,0.25)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 20 }}>🔔</span>
        <div style={{ flex: 1 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#C4B5FD" }}>Enable Notifications</p>
          <p style={{ margin: "2px 0 0", fontSize: 12, color: "#888" }}>
            {notifPermission === "denied"
              ? "Blocked — go to Settings › Safari › this site to allow"
              : "Get alerts for payments and expenses"}
          </p>
        </div>
        {notifPermission !== "denied" && (
          <button
            style={{ padding: "7px 14px", borderRadius: 20, border: "none", background: "#C4B5FD", color: "#0A0F1E", fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}
            onClick={handleEnable}
          >
            Enable
          </button>
        )}
      </div>
      {msg && (
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "#F59E0B", lineHeight: 1.4 }}>{msg}</p>
      )}
    </div>
  );
}

// ── DASHBOARD ─────────────────────────────────────────────────────────
function DashboardScreen({ user, balance, totalOwed, totalPaid, expenses, payments, syncingPayments, urgentCount, targetSummaries, onOpenTarget, onAddExpense, onLogPayment, onQuickPay, onConfirm, onResolveDispute, onRejectPayment, onDismissRejectedPayment, onNavigate, onLogout, onSwitchView, viewingAsCam, onLogPaymentForKey, onDisputeExpense }) {
  const pending = payments.filter((p) => !p.confirmed && !p.rejected);
  // Cam dashboard urgent banner improvement: Step 3
  const urgentList = (expenses || []).filter((e) => getUrgencyLevel(e) !== null);
  const overdueCount = urgentList.filter((e) => getUrgencyLevel(e) === "overdue").length;
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchVal, setSearchVal] = useState("");
  const [notifOpen, setNotifOpen] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);
  const [notifPermission, setNotifPermission] = useState(() =>
    typeof Notification !== "undefined" ? Notification.permission : "granted"
  );
  const [tokenSaved, setTokenSaved] = useState(() => localStorage.getItem("fcmTokenSaved") === user);

  const sortedByDate = (expenses || [])
    .filter((e) => e.status !== "paid")
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const q = String(searchVal || "").trim().toLowerCase();

  function fmtDate(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso + "T12:00:00");
      return [
        d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
        d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        d.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
        String(d.getFullYear()),
        iso,
      ].join(" ").toLowerCase();
    } catch { return iso.toLowerCase(); }
  }

  function matchesSearch(e, tokens) {
    const fields = [
      String(e.description || ""),
      String(e.category || ""),
      String(e.account || ""),
      String(e.amount ?? ""),
      String(e.referenceNum || ""),
      String(e.note || ""),
      fmtDate(e.date),
      fmtDate(e.nextDue || e.dueDate),
    ].map(s => s.toLowerCase());
    return tokens.every(t => fields.some(f => f.includes(t)));
  }

  const tokens = q ? q.split(/\s+/).map(t => t.replace(/^\$/, "")).filter(Boolean) : [];
  const filtered = tokens.length ? sortedByDate.filter(e => matchesSearch(e, tokens)) : sortedByDate;

  // Show 4 items normally; show all matches when searching
  const searchedRecent = tokens.length ? filtered : filtered.slice(0, 4);

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
          {user === "cam" ? (
            /* Bell notification icon — Cameron only */
            (() => {
              const today = new Date(); today.setHours(0,0,0,0);
              const upcomingCount = (expenses || []).filter((e) => {
                if (e.status === "paid") return false;
                const camOwes = e.split === "cam" || e.split === "split";
                if (!camOwes) return false;
                const due = e.nextDue || e.dueDate;
                if (!due) return false;
                const dueD = new Date(due + "T12:00:00");
                return Math.ceil((dueD - today) / 86400000) <= 14;
              }).length;
              const pendingCount = (payments || []).filter((p) => !p.confirmed).length;
              const badgeCount = upcomingCount + pendingCount;
              return (
                <button
                  type="button"
                  style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: 38, height: 38, borderRadius: "50%", border: "none", background: notifOpen ? "#E05C6E" : "#00314B", cursor: "pointer", boxShadow: "0 3px 10px rgba(0,49,75,0.3)" }}
                  onClick={() => setNotifOpen((o) => !o)}
                  aria-label="Notifications"
                >
                  {/* Filled bell icon */}
                  <svg width={28} height={28} viewBox="0 0 24 24" fill="#fff">
                    <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6V11c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
                  </svg>
                  {badgeCount > 0 && !notifOpen && (
                    <span style={{
                      position: "absolute",
                      top: -4,
                      right: -4,
                      minWidth: 18,
                      height: 18,
                      borderRadius: 9,
                      background: "#FF3B30",
                      border: "none",
                      fontSize: 10,
                      fontWeight: 800,
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      lineHeight: 1,
                      padding: "0 4px",
                      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
                      letterSpacing: -0.3,
                    }}>
                      {badgeCount > 9 ? "9+" : badgeCount}
                    </span>
                  )}
                </button>
              );
            })()
          ) : (
            /* Search button — Emma only */
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
                background: searchOpen ? "#00314B" : "rgba(255,255,255,0.7)",
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
          )}
          {onSwitchView ? (
            <button
              style={{ ...styles.logoutBtn, background: viewingAsCam ? "#00314B" : "rgba(255,255,255,0.7)", color: viewingAsCam ? "#C4B5FD" : "#888", fontWeight: 700 }}
              onClick={onSwitchView}
            >
              {viewingAsCam ? "My view" : "Cam's view"}
            </button>
          ) : (
            <button style={styles.logoutBtn} onClick={onLogout}>Sign out</button>
          )}
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

      {/* Push notification enable banner */}
      {(!tokenSaved || notifPermission !== "granted") && (
        <NotifEnableBanner user={user} notifPermission={notifPermission} setNotifPermission={setNotifPermission} setTokenSaved={setTokenSaved} />
      )}

      {/* Balance Banner — Emma */}
      {user === "emma" && (
        <>
          <EmmaBalanceBanner
            balance={balance}
            totalOwed={totalOwed}
            totalPaid={totalPaid}
            camOwesThisMonth={camOwesThisMonth}
            emmaPaidThisMonth={emmaPaidThisMonth}
            expenses={expenses}
            payments={payments}
            onAddExpense={onAddExpense}
            onLogPayment={onLogPayment}
          />
          <div style={{ display: "flex", gap: 12, padding: "0 16px", marginTop: 16, marginBottom: 20 }}>
            <DashboardPendingCard user={user} pendingPayments={pending} onConfirm={onConfirm} onResolveDispute={onResolveDispute} onRejectPayment={onRejectPayment} targetSummaries={targetSummaries} expenses={expenses} />
          </div>
        </>
      )}

      {/* Balance Banner — Cameron */}
      {user === "cam" && (
        <CamBalanceBanner
          balance={balance}
          totalOwed={totalOwed}
          totalPaid={totalPaid}
          camOwesThisMonth={camOwesThisMonth}
          camPaidThisMonth={camPaidThisMonth}
          overdueCount={overdueCount}
          expenses={expenses}
          payments={payments}
          onLogPayment={onLogPayment}
          onQuickPay={onQuickPay}
          onAddExpense={onAddExpense}
          onNavigate={onNavigate}
          onDisputeExpense={onDisputeExpense}
        />
      )}



      {/* Rejected payments card — Cameron only */}
      {user === "cam" && (
        <CamRejectedCard
          payments={payments}
          targetSummaries={targetSummaries}
          onLogPaymentForKey={onLogPaymentForKey}
          onDeletePayment={onDismissRejectedPayment}
        />
      )}

      {/* Urgent banner — Emma only */}
      {user !== "cam" && urgentCount > 0 && (
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
            boxShadow: "0 4px 16px rgba(0,49,75,0.09)",
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
              <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "#00314B" }}>
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
        <div style={{ ...styles.alertBox, background: "#EBF0E8", borderColor: "#A6B49E" }}>
          <Icon path={icons.clock} size={16} color="#2D5A4A" />
          <p style={{ color: "#1A3530", fontSize: 13, margin: 0 }}>
            Syncing your latest payment…
          </p>
        </div>
      )}

      {/* Action Buttons */}
      {user !== "emma" && user !== "cam" && (
        <div style={styles.actionRow}>
          <button style={{...styles.actionBtn, background: "linear-gradient(135deg, #A6B49E, #4E635E)"}} onClick={onAddExpense}>
            <Icon path={icons.plus} size={18} color="#fff" />
            <span>Add Expense</span>
          </button>
          <button style={{
            ...styles.actionBtn,
            background: "linear-gradient(135deg, #D5BD96, #7A9BB5)",
          }} onClick={onLogPayment}>
            <Icon path={icons.wallet} size={18} color="#fff" />
            <span>{user === "cam" ? "Log My Payment" : "Record Payment"}</span>
          </button>
        </div>
      )}


      {/* ── Emma: unified Recent Activity card ── */}
      {user === "emma" && (
        <div style={{ margin: "0 16px 28px", background: "#fff", borderRadius: 22, border: "1.5px solid #EDE7DC", boxShadow: "0 2px 16px rgba(0,49,75,0.07)", overflow: "hidden" }}>

          {/* Card header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px 8px" }}>
            <span style={{ fontSize: 15, fontWeight: 900, color: "#0A1E2B", letterSpacing: -0.2 }}>
              {tokens.length ? `${filtered.length} result${filtered.length !== 1 ? "s" : ""}` : "Recent Activity"}
            </span>
            {!tokens.length && (
              <button style={{ background: "none", border: "none", fontSize: 12, fontWeight: 700, color: "#A6B7CB", cursor: "pointer", padding: 0 }} onClick={() => onNavigate("expenses")}>
                See all
              </button>
            )}
          </div>

          {/* Recent transactions — always first */}
          {tokens.length && filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "28px 20px" }}>
              <p style={{ fontSize: 30, margin: 0 }}>🔍</p>
              <p style={{ fontWeight: 700, color: "#00314B", fontSize: 14, margin: "10px 0 4px" }}>No results</p>
              <p style={{ color: "#999", fontSize: 12, margin: 0 }}>Try a different amount, date, or description</p>
            </div>
          ) : (
            <div style={{ paddingBottom: 4 }}>
              <DashboardRecentChargesList items={searchedRecent} onOpenTarget={onOpenTarget} user={user} searching={tokens.length > 0} />
            </div>
          )}

          {/* Plan progress — expandable, below charges */}
          {!tokens.length && (planTargets.length > 0 || oneTimeTargets.length > 0) && (
            <div style={{ borderTop: "1px solid #EEE9E0" }}>

              {/* Toggle row */}
              <button
                type="button"
                onClick={() => setPlansOpen(o => !o)}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "11px 16px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 24, height: 24, borderRadius: 8, background: plansOpen ? "#EDE7DC" : "#EEE9E0", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#A6B7CB" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
                    </svg>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 800, color: "#00314B" }}>Plan progress</span>
                  {!plansOpen && (
                    <span style={{ fontSize: 11, color: "#BBB", fontWeight: 600 }}>
                      {planTargets.length} plan{planTargets.length !== 1 ? "s" : ""}{oneTimeTargets.length > 0 ? ` · ${oneTimeTargets.length} one-time` : ""}
                    </span>
                  )}
                </div>
                <svg
                  width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#D5BD96" strokeWidth={2.5} strokeLinecap="round"
                  style={{ transform: plansOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.25s ease" }}
                >
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>

              {/* Animated content */}
              <AnimatePresence initial={false}>
                {plansOpen && (
                  <motion.div
                    key="plans-panel"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
                    style={{ overflow: "hidden" }}
                  >
                    <div style={{ padding: "4px 16px 14px", display: "flex", flexDirection: "column", gap: 12 }}>

                      {/* Plans */}
                      {planTargets.map((p) => {
                        const charged = Number(p.charged || 0);
                        const paid = Number(p.paid || 0);
                        const remaining = Number(p.remaining || 0);
                        const pct = charged > 0 ? Math.max(0, Math.min(1, paid / charged)) : 0;
                        return (
                          <div key={p.key} onClick={() => onOpenTarget && onOpenTarget(p.key)} style={{ cursor: "pointer" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                              <span style={{ fontSize: 13, fontWeight: 700, color: "#0A1E2B" }}>{p.label}</span>
                              <span style={{ fontSize: 12, fontWeight: 800, color: pct >= 1 ? "#4E635E" : "#A6B7CB" }}>
                                {pct >= 1 ? "Fully paid ✓" : `$${remaining.toFixed(2)} left`}
                              </span>
                            </div>
                            <div style={{ height: 5, borderRadius: 999, background: "#EDE7DC", overflow: "hidden" }}>
                              <div style={{ height: "100%", borderRadius: 999, width: `${pct * 100}%`, background: pct >= 1 ? "linear-gradient(90deg, #A6B49E, #4E635E)" : "linear-gradient(90deg, #D5BD96, #1B4D6B)", transition: "width 0.5s" }} />
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
                              <span style={{ fontSize: 10, color: "#BBB", fontWeight: 600 }}>Paid ${paid.toFixed(2)}</span>
                              <span style={{ fontSize: 10, color: "#BBB", fontWeight: 600 }}>Total ${charged.toFixed(2)}</span>
                            </div>
                          </div>
                        );
                      })}

                      {/* One-time pills */}
                      {oneTimeTargets.length > 0 && (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {oneTimeTargets.slice(0, 10).map(t => {
                            const rem = Number(t.remaining || 0);
                            const isPaid = rem <= 0;
                            return (
                              <button
                                key={t.key} type="button"
                                onClick={() => onOpenTarget && onOpenTarget(t.key)}
                                style={{
                                  display: "flex", alignItems: "center", gap: 5,
                                  padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                                  background: isPaid ? "#EBF0E8" : "#EEE9E0",
                                  border: `1.5px solid ${isPaid ? "#B8CDB5" : "#DDD5C5"}`,
                                }}
                              >
                                {isPaid && <svg width={10} height={10} viewBox="0 0 24 24" fill="#4E635E"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>}
                                <span style={{ fontSize: 11, fontWeight: 700, color: isPaid ? "#4E635E" : "#00314B", whiteSpace: "nowrap" }}>{t.label}</span>
                                {!isPaid && <span style={{ fontSize: 11, color: "#A6B7CB", fontWeight: 700 }}>${rem.toFixed(2)}</span>}
                              </button>
                            );
                          })}
                        </div>
                      )}

                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      )}

      {/* ── Cameron: unified Recent Activity card (same pattern as Emma) ── */}
      {user !== "emma" && (
        <div style={{ margin: "20px 16px 28px", background: "#fff", borderRadius: 22, border: "1.5px solid #EDE7DC", boxShadow: "0 2px 16px rgba(0,49,75,0.07)", overflow: "hidden" }}>

          {/* Card header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px 8px" }}>
            <span style={{ fontSize: 15, fontWeight: 900, color: "#0A1E2B", letterSpacing: -0.2 }}>
              {tokens.length ? `${filtered.length} result${filtered.length !== 1 ? "s" : ""}` : "Recent Activity"}
            </span>
            {!tokens.length && (
              <button style={{ background: "none", border: "none", fontSize: 12, fontWeight: 700, color: "#A6B7CB", cursor: "pointer", padding: 0 }} onClick={() => onNavigate("expenses")}>
                View all
              </button>
            )}
          </div>

          {/* Recent charges — always first */}
          {tokens.length && filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "28px 20px" }}>
              <p style={{ fontSize: 30, margin: 0 }}>🔍</p>
              <p style={{ fontWeight: 700, color: "#00314B", fontSize: 14, margin: "10px 0 4px" }}>No results</p>
              <p style={{ color: "#999", fontSize: 12, margin: 0 }}>Try a different amount, date, or description</p>
            </div>
          ) : (
            <div style={{ paddingBottom: 4 }}>
              <DashboardRecentChargesList items={searchedRecent} onOpenTarget={onOpenTarget} user={user} searching={tokens.length > 0} />
            </div>
          )}

          {/* Plan progress — expandable */}
          {!tokens.length && (planTargets.length > 0 || oneTimeTargets.length > 0) && (
            <div style={{ borderTop: "1px solid #EEE9E0" }}>
              <button
                type="button"
                onClick={() => setPlansOpen(o => !o)}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "11px 16px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 24, height: 24, borderRadius: 8, background: plansOpen ? "#EDE7DC" : "#EEE9E0", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#A6B7CB" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
                    </svg>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 800, color: "#00314B" }}>Plan progress</span>
                  {!plansOpen && (
                    <span style={{ fontSize: 11, color: "#BBB", fontWeight: 600 }}>
                      {planTargets.length} plan{planTargets.length !== 1 ? "s" : ""}{oneTimeTargets.length > 0 ? ` · ${oneTimeTargets.length} one-time` : ""}
                    </span>
                  )}
                </div>
                <svg
                  width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#D5BD96" strokeWidth={2.5} strokeLinecap="round"
                  style={{ transform: plansOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.25s ease" }}
                >
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>

              <AnimatePresence initial={false}>
                {plansOpen && (
                  <motion.div
                    key="cam-plans-panel"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
                    style={{ overflow: "hidden" }}
                  >
                    <div style={{ padding: "4px 16px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
                      {planTargets.map((p) => {
                        const charged = Number(p.charged || 0);
                        const paid = Number(p.paid || 0);
                        const remaining = Number(p.remaining || 0);
                        const pct = charged > 0 ? Math.max(0, Math.min(1, paid / charged)) : 0;
                        return (
                          <div key={p.key} onClick={() => onOpenTarget && onOpenTarget(p.key)} style={{ cursor: "pointer" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                              <span style={{ fontSize: 13, fontWeight: 700, color: "#0A1E2B" }}>{p.label}</span>
                              <span style={{ fontSize: 12, fontWeight: 800, color: pct >= 1 ? "#4E635E" : "#A6B7CB" }}>
                                {pct >= 1 ? "Fully paid ✓" : `$${remaining.toFixed(2)} left`}
                              </span>
                            </div>
                            <div style={{ height: 5, borderRadius: 999, background: "#EDE7DC", overflow: "hidden" }}>
                              <div style={{ height: "100%", borderRadius: 999, width: `${pct * 100}%`, background: pct >= 1 ? "linear-gradient(90deg, #A6B49E, #4E635E)" : "linear-gradient(90deg, #D5BD96, #1B4D6B)", transition: "width 0.5s" }} />
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
                              <span style={{ fontSize: 10, color: "#BBB", fontWeight: 600 }}>Paid ${paid.toFixed(2)}</span>
                              <span style={{ fontSize: 10, color: "#BBB", fontWeight: 600 }}>Total ${charged.toFixed(2)}</span>
                            </div>
                          </div>
                        );
                      })}
                      {oneTimeTargets.length > 0 && (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {oneTimeTargets.slice(0, 10).map(t => {
                            const rem = Number(t.remaining || 0);
                            const isPaid = rem <= 0;
                            return (
                              <button
                                key={t.key} type="button"
                                onClick={() => onOpenTarget && onOpenTarget(t.key)}
                                style={{
                                  display: "flex", alignItems: "center", gap: 5,
                                  padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                                  background: isPaid ? "#EBF0E8" : "#EEE9E0",
                                  border: `1.5px solid ${isPaid ? "#B8CDB5" : "#DDD5C5"}`,
                                }}
                              >
                                {isPaid && <svg width={10} height={10} viewBox="0 0 24 24" fill="#4E635E"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>}
                                <span style={{ fontSize: 11, fontWeight: 700, color: isPaid ? "#4E635E" : "#00314B", whiteSpace: "nowrap" }}>{t.label}</span>
                                {!isPaid && <span style={{ fontSize: 11, color: "#A6B7CB", fontWeight: 700 }}>${rem.toFixed(2)}</span>}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      )}

      <div style={{height: 80}} />

      {/* Notifications Panel — Cameron */}
      {notifOpen && (
        <CamNotificationsPanel
          expenses={expenses}
          payments={payments}
          onClose={() => setNotifOpen(false)}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}

// ── URGENT SCREEN ────────────────────────────────────────────────────
function UrgentScreen({ expenses, user, onBack, onMarkPaid, onLogPaymentForKey }) {
  const isCam = user === "cam";
  const [expandedId, setExpandedId] = useState(null);

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
            color: "#00314B",
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
            <p style={{ fontWeight: 700, color: "#00314B", fontSize: 18, margin: "12px 0 4px" }}>
              All clear!
            </p>
            <p style={{ color: "#999", fontSize: 13, margin: 0 }}>No overdue or upcoming payments</p>
          </div>
        ) : (
          sorted.map((e) => {
            const level = getUrgencyLevel(e);
            const u = URGENCY[level];
            const days = getDaysUntilDue(e.nextDue || e.dueDate);
            const isExpanded = expandedId === e.id;

            const dueLabel =
              days < 0
                ? `${Math.abs(days)} day${Math.abs(days) !== 1 ? "s" : ""} overdue`
                : days === 0
                ? "Due TODAY"
                : days === 1
                ? "Due TOMORROW"
                : `Due in ${days} days`;

            const camAmt = e.split === "cam" ? Number(e.amount) : e.split === "split" ? Number(e.amount) / 2 : 0;

            return (
              <div
                key={e.id}
                style={{
                  background: u.bg,
                  border: `1.5px solid ${isExpanded ? u.badge : u.border}`,
                  borderRadius: 16,
                  marginBottom: 10,
                  overflow: "hidden",
                  cursor: "pointer",
                }}
                onClick={() => setExpandedId(isExpanded ? null : e.id)}
              >
                {/* Header row */}
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: 16 }}>
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
                    <p style={{ fontSize: 14, fontWeight: 700, color: "#00314B", margin: "0 0 2px" }}>
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
                    <p style={{ fontSize: 18, fontWeight: 800, color: "#00314B", margin: 0 }}>
                      ${Number(e.amount || 0).toFixed(2)}
                    </p>
                    {camAmt > 0 && (
                      <p style={{ fontSize: 12, color: "#E8A0B0", fontWeight: 700, margin: "2px 0 0" }}>
                        {isCam ? "You owe:" : "Cam owes:"} ${camAmt.toFixed(2)}
                      </p>
                    )}
                    {user === "emma" && !e._optimistic && (
                      <button
                        style={styles.markPaidBtn}
                        onClick={(ev) => { ev.stopPropagation(); onMarkPaid(e.id); }}
                      >
                        Mark paid
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded section */}
                {isExpanded && (
                  <div
                    style={{ borderTop: `1px solid ${u.border}`, padding: "12px 16px 14px", background: "rgba(255,255,255,0.55)" }}
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    {e.referenceNum && (
                      <p style={{ fontSize: 12, color: "#888", margin: "0 0 6px" }}>
                        <span style={{ fontWeight: 700, color: "#00314B" }}>Ref #</span> {e.referenceNum}
                      </p>
                    )}
                    {e.note && (
                      <div style={{ marginBottom: isCam ? 12 : 0 }}>
                        <p style={{ fontSize: 11, fontWeight: 700, color: "#A6B7CB", margin: "0 0 4px", textTransform: "uppercase", letterSpacing: 0.4 }}>Note</p>
                        {renderNote(e.note)}
                      </div>
                    )}
                    {!e.referenceNum && !e.note && (
                      <p style={{ fontSize: 12, color: "#BBB", margin: "0 0 8px", fontStyle: "italic" }}>No notes or reference number.</p>
                    )}
                    {isCam && typeof onLogPaymentForKey === "function" && (
                      <button
                        style={{
                          marginTop: 8,
                          width: "100%",
                          padding: "11px",
                          borderRadius: 12,
                          border: "none",
                          background: u.badge,
                          color: "#fff",
                          fontSize: 13,
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                        onClick={() => onLogPaymentForKey(`exp:${e.id}`, camAmt > 0 ? camAmt : Number(e.amount))}
                      >
                        Log Payment
                      </button>
                    )}
                  </div>
                )}
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
  onEditExpense,
  onMarkPaid,
  targetSummaries,
  onQuickAdd,
  onLogPaymentForKey,
  onDisputeExpense,
}) {
  const isCam = user === "cam";
  const screenRef = useRef(null);

  const [statusFilter, setStatusFilter] = useState("all"); // all | active | unpaid | overdue | fullypaid | paid | installments
  const [sortBy, setSortBy] = useState("newest");
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);

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

  function matchesStatusFilter(e) {
    const isPaid = e?.status === "paid";
    const isCredit = e?.split === "ella";
    const isRecurring = e?.recurring && e.recurring !== "none";
    const isOverdue = getUrgencyLevel(e) === "overdue";

    if (statusFilter === "paid") {
      if (isPaid) return true;
      const expKey = isRecurring ? `grp:${e.groupId || e.id}` : `exp:${e.id}`;
      return (payments || []).some(p => {
        if (!p?.confirmed) return false;
        const key = p.appliedToKey || (p.appliedToGroupId ? `grp:${p.appliedToGroupId}` : "general");
        return key === expKey;
      });
    }
    if (statusFilter === "unpaid")   return !isPaid && !isCredit;
    if (statusFilter === "overdue")  return isOverdue && !isPaid;
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

  const combinedFiltered = baseFiltered;

  // ---- Sort ----
  function applySort(list) {
    const sorted = [...list];
    if (sortBy === "newest")     return sorted.sort((a, b) => new Date(b.date) - new Date(a.date));
    if (sortBy === "oldest")     return sorted.sort((a, b) => new Date(a.date) - new Date(b.date));
    if (sortBy === "amount")     return sorted.sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0));
    if (sortBy === "dueDate") {
      return sorted.sort((a, b) => {
        const da = a.dueDate || a.nextDue || null;
        const db = b.dueDate || b.nextDue || null;
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return new Date(da) - new Date(db);
      });
    }
    if (sortBy === "unpaidFirst") {
      return sorted.sort((a, b) => {
        const pa = a.status === "paid" ? 1 : 0;
        const pb = b.status === "paid" ? 1 : 0;
        if (pa !== pb) return pa - pb;
        return new Date(b.date) - new Date(a.date);
      });
    }
    return sorted;
  }

  // ---- Search logic ----
  const search = useExpensesSearchLogic(baseFiltered);
  const listToRender = searchOpen ? search.filteredExpenses : applySort(combinedFiltered);

  // ---- Due date summary (shown beneath sort bar) ----
  const dueDateSummary = (() => {
    const today = new Date(); today.setHours(0,0,0,0);
    const withDue = combinedFiltered.filter(e => e.status !== "paid" && (e.nextDue || e.dueDate));
    const overdueItems = withDue.filter(e => getUrgencyLevel(e) === "overdue");
    const upcomingItems = withDue.filter(e => getUrgencyLevel(e) !== "overdue").sort((a,b) => {
      const da = a.nextDue || a.dueDate, db = b.nextDue || b.dueDate;
      return new Date(da) - new Date(db);
    });
    return { overdueCount: overdueItems.length, next: upcomingItems[0] || null };
  })();

  // ---- Group recurring expenses by groupId ----
  const groupedList = (() => {
    const result = [];
    const seen = new Map(); // gid → index in result
    for (const e of listToRender) {
      const isRecurring = e.recurring && e.recurring !== "none";
      const gid = isRecurring ? (e.groupId || e.id) : null;
      if (gid && seen.has(gid)) {
        result[seen.get(gid)].items.push(e);
      } else if (gid) {
        seen.set(gid, result.length);
        result.push({ _isGroup: true, gid, items: [e] });
      } else {
        result.push(e);
      }
    }
    return result;
  })();


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
      border: "1px solid #EDE7DC",
      borderRadius: 22,
      boxShadow: "0 8px 30px rgba(0,49,75,0.10)",
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
      color: "#00314B",
      cursor: "pointer",
    },
    title: {
      flex: 1,
      minWidth: 0,
      textAlign: "center",
      fontSize: 16,
      fontWeight: 900,
      color: isCam ? "#7A1C3E" : "#00314B",
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
      background: search.searchActive ? (isCam ? "#E05C6E" : "#00314B") : "rgba(255,255,255,0.7)",
      color: search.searchActive ? "#fff" : isCam ? "#E05C6E" : "#00314B",
      cursor: "pointer",
    },
    addBtn: {
      width: 40,
      height: 40,
      borderRadius: 14,
      border: "none",
      background: "linear-gradient(135deg, #A6B49E, #4E635E)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
    },
    pillWrap: { padding: "0 12px 12px" },
    maroonPill: {
      background: "linear-gradient(135deg, #00314B, #1B4D6B)",
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
      border: "1.5px solid #DDD5C5",
      background: "#fff",
      fontSize: 13,
      fontWeight: 800,
      color: "#888",
      cursor: "pointer",
      whiteSpace: "nowrap",
    },
    chipActive: {
      background: isCam ? "#FFF0F0" : "#00314B",
      color: isCam ? "#E05C6E" : "#fff",
      borderColor: isCam ? "#E8A0B0" : "#00314B",
    },
    searchRow: { padding: "10px 12px 12px" },
    searchFieldWrap: { position: "relative", display: "flex", alignItems: "center" },
    searchIcon: { position: "absolute", left: 12, display: "flex", alignItems: "center", justifyContent: "center" },
    searchInput: {
      width: "100%",
      padding: "10px 36px 10px 34px",
      borderRadius: 12,
      border: "1.5px solid #DDD5C5",
      background: "#fff",
      fontSize: 15,
      color: "#00314B",
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
              <Icon path={icons.back} size={18} color={isCam ? "#7A1C3E" : "#00314B"} />
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
                  <Icon path={icons.search} size={18} color={isCam ? "#E05C6E" : "#00314B"} />
                )}
              </button>

              {!isCam && (
                <button
                  type="button"
                  style={island.addBtn}
                  onClick={() => setQuickAddOpen(true)}
                  aria-label="Quick add expense"
                >
                  <span style={{ fontSize: 24, fontWeight: 300, color: "#fff", lineHeight: 1, marginTop: -1 }}>+</span>
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
            <div style={{ ...island.filterRow, WebkitOverflowScrolling: "touch", scrollbarWidth: "none", msOverflowStyle: "none" }}>
              {(isCam
                ? [["all","All"],["unpaid","Unpaid"],["overdue","Overdue"],["installments","Plans"],["paid","Paid"]]
                : [["all","All"],["unpaid","Unpaid"],["overdue","Overdue"],["paid","Paid"]]
              ).map(([val, label]) => {
                const isActive = statusFilter === val;
                const isOverdue = val === "overdue";
                return (
                  <button
                    key={val}
                    type="button"
                    className={isActive ? "lg-chip-active" : ""}
                    onClick={() => setStatusFilter(val)}
                    style={{
                      ...island.chip,
                      transition: "background 0.22s ease, color 0.22s ease, border-color 0.22s ease, transform 0.1s ease",
                      ...(isActive ? {
                        ...island.chipActive,
                        ...(isOverdue ? { background: "#E05C6E", borderColor: "#E05C6E", color: "#fff" } : {}),
                        transform: "scale(1.04)",
                      } : {}),
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Sort row */}
          {!search.searchActive && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 12px 10px" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#AAA", textTransform: "uppercase", letterSpacing: 0.5, flexShrink: 0 }}>Sort</span>
              <div style={{ display: "flex", gap: 6, overflowX: "auto", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", msOverflowStyle: "none" }}>
                {[
                  ["newest",     "Newest"],
                  ["oldest",     "Oldest"],
                  ["amount",     "Highest $"],
                  ["dueDate",    "Due Date"],
                  ["unpaidFirst","Unpaid First"],
                ].map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    className={sortBy === val ? "lg-chip-active" : ""}
                    onClick={() => setSortBy(val)}
                    style={{
                      flexShrink: 0,
                      padding: "4px 12px",
                      borderRadius: 999,
                      border: "1.5px solid",
                      borderColor: sortBy === val ? (isCam ? "#E05C6E" : "#00314B") : "#DDD5C5",
                      background: sortBy === val ? (isCam ? "#FFF0F0" : "#EDE7DC") : "transparent",
                      color: sortBy === val ? (isCam ? "#E05C6E" : "#00314B") : "#AAA",
                      fontWeight: sortBy === val ? 700 : 500,
                      fontSize: 11,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      transition: "background 0.22s ease, color 0.22s ease, border-color 0.22s ease, transform 0.1s ease",
                      transform: sortBy === val ? "scale(1.05)" : "scale(1)",
                      fontFamily: "inherit",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Due date summary strip */}
          {!search.searchActive && (dueDateSummary.overdueCount > 0 || dueDateSummary.next) && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 14px 10px", flexWrap: "wrap" }}>
              {dueDateSummary.overdueCount > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, color: "#E05C6E", background: "#FFF0F0", borderRadius: 8, padding: "3px 10px" }}>
                  {dueDateSummary.overdueCount} overdue
                </span>
              )}
              {dueDateSummary.next && (
                <span style={{ fontSize: 11, fontWeight: 600, color: "#A6B7CB", background: "#EEE9E0", borderRadius: 8, padding: "3px 10px" }}>
                  Next due · {formatShortDate(dueDateSummary.next.nextDue || dueDateSummary.next.dueDate)} · {dueDateSummary.next.description}
                </span>
              )}
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
            <Icon path={icons.search} size={48} color="#D5BD96" />
          </div>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 900, color: "#00314B" }}>No results found</p>
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "#888" }}>
            {isCam ? `No charges match "${search.searchQuery}"` : `No expenses match "${search.searchQuery}"`}
          </p>
        </div>
      ) : (
        <motion.div layout style={{ padding: "0 16px" }}>
          {groupedList.map((item) => item._isGroup ? (
            <GroupExpenseRow
              key={`grp:${item.gid}`}
              gid={item.gid}
              items={item.items}
              user={user}
              targetSummaries={targetSummaries}
              onMarkPaid={onMarkPaid}
              onEdit={onEditExpense}
              onLogPaymentForKey={onLogPaymentForKey}
            />
          ) : (
            <ExpenseRow
              key={item.id}
              expense={item}
              user={user}
              onDelete={onDeleteExpense}
              onEdit={onEditExpense}
              onMarkPaid={onMarkPaid}
              targetSummaries={targetSummaries}
              payments={payments}
              onLogPaymentForKey={onLogPaymentForKey}
              onDispute={onDisputeExpense}
            />
          ))}
        </motion.div>
      )}

      <div style={{ height: 80 }} />

      {quickAddOpen && (
        <QuickAddModal
          user={user}
          onSave={(exp) => {
            if (typeof onQuickAdd === "function") onQuickAdd(exp);
            setQuickAddOpen(false);
          }}
          onClose={() => setQuickAddOpen(false)}
        />
      )}
    </div>
  );
}

// ── HISTORY SCREEN ────────────────────────────────────────────────────
function HistoryScreen({ expenses, payments, user, targets = [], onBack, onConfirm, onDeleteConfirmedPayment, onDeleteExpense }) {
  const [expandedPaymentId, setExpandedPaymentId] = useState(null);

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

  function relatedExpense(p) {
    const key = p.appliedToKey || (p.appliedToGroupId ? `grp:${p.appliedToGroupId}` : "general");
    if (!key || key === "general") return null;
    if (key.startsWith("exp:")) return (expenses || []).find(e => e.id === key.slice(4)) || null;
    if (key.startsWith("grp:")) {
      const gid = key.slice(4);
      return (expenses || []).find(e => (e.groupId || e.id) === gid) || null;
    }
    return null;
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
            color: "#00314B",
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
      {all.map((item, i) => {
        if (item.type === "payment") {
          const lbl  = paymentTargetLabel(item);
          const rExp = relatedExpense(item);
          const isOpen = expandedPaymentId === item.id;
          const isConfirmed = item.confirmed;
          const isRejected  = item.rejected && !item.confirmed;
          const statusColor = isConfirmed ? "#2D5A4A" : isRejected ? "#E07A20" : "#C8A020";
          const statusBg   = isConfirmed ? "#EBF5EF"  : isRejected ? "#FFF0E0" : "#FDF7E3";
          return (
            <div key={i} style={{ borderBottom: "1px solid #EDE7DC" }}>
              {/* Collapsed header — always visible, tap to toggle */}
              <div
                role="button"
                style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", cursor: "pointer" }}
                onClick={() => setExpandedPaymentId(isOpen ? null : item.id)}
              >
                <PaymentMethodIcon method={item.method} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#1A1A1A", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.method} Payment
                    </p>
                    <p style={{ margin: 0, fontSize: 16, fontWeight: 800, color: "#2D5A4A", flexShrink: 0 }}>
                      -${Number(item.amount || 0).toFixed(2)}
                    </p>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: statusColor, background: statusBg, borderRadius: 6, padding: "2px 8px" }}>
                      {isConfirmed ? "confirmed" : isRejected ? "returned" : "pending"}
                    </span>
                    <Icon path={isOpen ? icons.chevronUp : icons.chevronDown} size={13} color="#CCC" />
                  </div>
                </div>
              </div>

              {/* Expanded detail panel */}
              {isOpen && (() => {
                const hRow = (label, value, mono = false) => (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                    <span style={{ fontSize: 11, color: "#AAA", fontWeight: 600, flexShrink: 0 }}>{label}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#1A1A1A", textAlign: "right", fontFamily: mono ? "monospace" : "inherit" }}>{value}</span>
                  </div>
                );
                const splitLabel = (s) => s === "cam" ? "Cameron pays full" : s === "split" ? "Split 50/50" : s === "ella" ? "Emmanuella pays full" : s;
                return (
                  <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>

                    {/* ── Payment receipt ── */}
                    <div style={{ background: isConfirmed ? "#EEF5EE" : isRejected ? "#FFF8F0" : "#FDFAF0", borderRadius: 14, padding: "14px", border: `1.5px solid ${isConfirmed ? "#C5DDCA" : isRejected ? "#F5C4A0" : "#ECD98A"}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${isConfirmed ? "#D5E8D8" : isRejected ? "#F0D0B0" : "#F0E6A0"}` }}>
                        <span style={{ fontSize: 11, fontWeight: 800, color: "#888", textTransform: "uppercase", letterSpacing: 0.6 }}>Payment</span>
                        <span style={{ fontSize: 11, fontWeight: 800, color: statusColor, background: statusBg, borderRadius: 6, padding: "3px 10px" }}>
                          {isConfirmed ? "✓ Confirmed" : isRejected ? "↩ Returned" : "⏳ Pending"}
                        </span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {hRow("Amount", `$${Number(item.amount || 0).toFixed(2)}`)}
                        {hRow("Method", item.method)}
                        {hRow("Date paid", formatPaymentDateTime(item))}
                        {item.note && hRow("Note", `"${item.note}"`)}
                        {isRejected && item.rejectionReason && (
                          <div style={{ marginTop: 4, paddingTop: 8, borderTop: `1px solid #F0D0B0` }}>
                            <p style={{ margin: "0 0 3px", fontSize: 10, fontWeight: 800, color: "#E07A20", textTransform: "uppercase", letterSpacing: 0.5 }}>Emmanuella's note</p>
                            <p style={{ margin: 0, fontSize: 12, color: "#555", fontStyle: "italic", lineHeight: 1.5 }}>"{item.rejectionReason}"</p>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* ── Original expense ── */}
                    {rExp ? (
                      <div style={{ background: "#F5F1EB", borderRadius: 14, padding: "14px", border: "1.5px solid #EDE7DC" }}>
                        <div style={{ marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid #EDE7DC" }}>
                          <span style={{ fontSize: 11, fontWeight: 800, color: "#888", textTransform: "uppercase", letterSpacing: 0.6 }}>Original Expense</span>
                        </div>
                        {/* Description + full amount */}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                          <span style={{ fontSize: 14, fontWeight: 800, color: "#00314B", flex: 1, minWidth: 0 }}>{rExp.description}</span>
                          <span style={{ fontSize: 14, fontWeight: 900, color: "#00314B", flexShrink: 0 }}>${Number(rExp.amount || 0).toFixed(2)}</span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {rExp.category && hRow("Category", rExp.category)}
                          {rExp.split && hRow("Split", splitLabel(rExp.split))}
                          {rExp.account && hRow("Charged to", rExp.account)}
                          {rExp.recurring && rExp.recurring !== "none" && hRow("Recurring", rExp.recurring)}
                          {rExp.dueDate && hRow("Due date", formatShortDate(rExp.dueDate))}
                          {rExp.referenceNum && hRow("Ref #", rExp.referenceNum, true)}
                          {rExp.note && hRow("Expense note", `"${rExp.note}"`)}
                          {/* Expense paid status */}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 6, borderTop: "1px solid #EDE7DC", marginTop: 2 }}>
                            <span style={{ fontSize: 11, color: "#AAA", fontWeight: 600 }}>Expense status</span>
                            <span style={{ fontSize: 11, fontWeight: 800, color: rExp.status === "paid" ? "#2D5A4A" : "#C8A020", background: rExp.status === "paid" ? "#EBF5EF" : "#FDF7E3", borderRadius: 6, padding: "3px 10px" }}>
                              {rExp.status === "paid" ? "Paid" : "Unpaid"}
                            </span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ background: "#F5F1EB", borderRadius: 14, padding: "12px 14px", border: "1.5px solid #EDE7DC" }}>
                        {hRow("Applied to", lbl || "General balance")}
                      </div>
                    )}

                    {/* ── Actions (Emma only) ── */}
                    {user === "emma" && (
                      <div style={{ display: "flex", gap: 8 }}>
                        {!isConfirmed && (
                          <button
                            style={{ flex: 1, background: "linear-gradient(135deg, #A6B49E, #4E635E)", color: "#fff", border: "none", borderRadius: 12, padding: "12px 0", fontSize: 13, fontWeight: 800, cursor: "pointer" }}
                            onClick={() => { onConfirm(item.id); setExpandedPaymentId(null); }}
                          >
                            ✓ Confirm Payment
                          </button>
                        )}
                        {isConfirmed && (
                          <button
                            style={{ flex: 1, background: "#FFF0F2", color: "#C0485A", border: "1.5px solid #F5C4CD", borderRadius: 12, padding: "12px 0", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
                            onClick={() => onDeleteConfirmedPayment(item.id)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        }

        // Expense row — tappable to expand full details
        const isExpOpen = expandedPaymentId === `exp-${item.id}`;
        const splitLabel = (s) => s === "cam" ? "Cameron pays full" : s === "split" ? "Split 50/50" : s === "ella" ? "Emmanuella pays full" : s;
        const hRow = (label, value, mono = false) => (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <span style={{ fontSize: 11, color: "#AAA", fontWeight: 600, flexShrink: 0 }}>{label}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#1A1A1A", textAlign: "right", fontFamily: mono ? "monospace" : "inherit" }}>{value}</span>
          </div>
        );
        return (
          <div key={i} style={{ borderBottom: "1px solid #EDE7DC" }}>
            {/* Collapsed header */}
            <div
              role="button"
              style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", cursor: "pointer" }}
              onClick={() => setExpandedPaymentId(isExpOpen ? null : `exp-${item.id}`)}
            >
              <div style={{ ...styles.historyIcon, background: "#EDE4F5", flexShrink: 0 }}>
                <Icon path={icons.list} size={18} color="#5B3B8C" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#1A1A1A", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.description}
                  </p>
                  <p style={{ margin: 0, fontSize: 16, fontWeight: 800, color: "#9E4C6A", flexShrink: 0 }}>
                    ${(item.split === "split" ? item.amount / 2 : item.amount).toFixed(2)}
                  </p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 4 }}>
                  <span style={{ fontSize: 11, color: "#AAA" }}>{formatHistoryDate(item.date)}</span>
                  {item.status === "paid" && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#2D5A4A", background: "#EBF5EF", borderRadius: 6, padding: "2px 8px" }}>paid</span>
                  )}
                  <Icon path={isExpOpen ? icons.chevronUp : icons.chevronDown} size={13} color="#CCC" />
                </div>
              </div>
            </div>

            {/* Expanded detail panel */}
            {isExpOpen && (
              <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ background: "#F5F1EB", borderRadius: 14, padding: "14px", border: "1.5px solid #EDE7DC" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid #EDE7DC" }}>
                    <span style={{ fontSize: 14, fontWeight: 800, color: "#00314B", flex: 1, minWidth: 0 }}>{item.description}</span>
                    <span style={{ fontSize: 14, fontWeight: 900, color: "#00314B", flexShrink: 0 }}>${Number(item.amount || 0).toFixed(2)}</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {item.category && hRow("Category", item.category)}
                    {item.split && hRow("Split", splitLabel(item.split))}
                    {item.account && hRow("Charged to", item.account)}
                    {item.recurring && item.recurring !== "none" && hRow("Recurring", item.recurring)}
                    {(item.dueDate || item.nextDue) && hRow("Due date", formatShortDate(item.dueDate || item.nextDue))}
                    {item.referenceNum && hRow("Ref #", item.referenceNum, true)}
                    {item.note && hRow("Note", `"${item.note}"`)}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 6, borderTop: "1px solid #EDE7DC", marginTop: 2 }}>
                      <span style={{ fontSize: 11, color: "#AAA", fontWeight: 600 }}>Status</span>
                      <span style={{ fontSize: 11, fontWeight: 800, color: item.status === "paid" ? "#2D5A4A" : "#C8A020", background: item.status === "paid" ? "#EBF5EF" : "#FDF7E3", borderRadius: 6, padding: "3px 10px" }}>
                        {item.status === "paid" ? "Paid" : "Unpaid"}
                      </span>
                    </div>
                  </div>
                </div>
                {item.status === "paid" && user === "emma" && typeof onDeleteExpense === "function" && (
                  <button
                    style={{ background: "#FFF0F2", color: "#C0485A", border: "1.5px solid #F5C4CD", borderRadius: 12, padding: "12px 0", fontSize: 13, fontWeight: 700, cursor: "pointer", width: "100%" }}
                    onClick={() => onDeleteExpense(item.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div style={{height: 80}} />
    </div>
  );
}


// ── GROUP EXPENSE ROW ─────────────────────────────────────────────────
function GroupSubRow({ expense: e, user, onMarkPaid, onEdit, isLast }) {
  const isCam = user === "cam";
  const camShare = e.split === "cam" ? Number(e.amount) : e.split === "split" ? Number(e.amount) / 2 : e.split === "ella" ? -Number(e.amount) : 0;
  const amt = isCam ? Math.abs(camShare) : Number(e.amount);
  const isPaid = e.status === "paid";
  const isOverdue = getUrgencyLevel(e) === "overdue";
  const statusLabel = isPaid ? "Paid" : isOverdue ? "Overdue" : "Unpaid";
  const statusColor = isPaid ? "#2D5A4A" : isOverdue ? "#E05C6E" : "#888";
  const statusBg = isPaid ? "#EBF0E8" : isOverdue ? "#FFF0F0" : "#F5F5F5";
  const displayDate = e.nextDue || e.dueDate || e.date;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: isLast ? "none" : "1px solid #EEE9E0" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 12, fontWeight: 600, color: "#00314B", margin: 0 }}>{formatShortDate(displayDate)}</p>
      </div>
      <span style={{ fontSize: 10, fontWeight: 700, color: statusColor, background: statusBg, borderRadius: 6, padding: "2px 7px", flexShrink: 0 }}>{statusLabel}</span>
      <p style={{ fontSize: 13, fontWeight: 700, color: "#00314B", margin: 0, minWidth: 52, textAlign: "right" }}>${amt.toFixed(2)}</p>
      {user === "emma" && !isPaid && typeof onMarkPaid === "function" && (
        <button
          style={{ fontSize: 11, fontWeight: 700, background: "#A6B49E", color: "#fff", border: "none", borderRadius: 8, padding: "4px 10px", cursor: "pointer", flexShrink: 0 }}
          onClick={(ev) => { ev.stopPropagation(); onMarkPaid(e.id); }}
        >
          Mark paid
        </button>
      )}
      {typeof onEdit === "function" && user !== "cam" && (
        <button
          style={{ background: "none", border: "none", padding: 4, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center" }}
          onClick={(ev) => { ev.stopPropagation(); onEdit(e); }}
          aria-label="Edit"
        >
          <Icon path={icons.edit} size={14} color="#AAA" />
        </button>
      )}
    </div>
  );
}

function GroupExpenseRow({ gid, items, user, targetSummaries, onMarkPaid, onEdit, onLogPaymentForKey }) {
  const [expanded, setExpanded] = useState(false);
  const isCam = user === "cam";
  const targetKey = `grp:${gid}`;
  const summary = targetSummaries?.get(targetKey);

  const totalCharged = summary
    ? Math.abs(Number(summary.charged || 0))
    : items.reduce((s, e) => {
        const share = e.split === "cam" ? Number(e.amount) : e.split === "split" ? Number(e.amount) / 2 : Number(e.amount);
        return s + (isCam ? share : Number(e.amount));
      }, 0);
  const totalPaid = summary ? Math.abs(Number(summary.paid || 0)) : 0;
  const remaining = summary ? Math.max(0, Math.abs(Number(summary.remaining || 0))) : Math.max(0, totalCharged - totalPaid);
  const pct = totalCharged > 0 ? Math.min(1, totalPaid / totalCharged) : 0;

  const paidCount = items.filter((e) => e.status === "paid").length;
  const allPaid = paidCount === items.length;
  const anyOverdue = items.some((e) => getUrgencyLevel(e) === "overdue");
  const description = items[0]?.description || "Group";
  const split = items[0]?.split;

  // Next unpaid installment due date
  const nextDueItem = items
    .filter((e) => e.status !== "paid" && (e.nextDue || e.dueDate))
    .sort((a, b) => new Date(a.nextDue || a.dueDate) - new Date(b.nextDue || b.dueDate))[0] || null;
  const nextDueDate = nextDueItem ? (nextDueItem.nextDue || nextDueItem.dueDate) : null;
  const nextDueOverdue = nextDueItem ? getUrgencyLevel(nextDueItem) === "overdue" : false;

  return (
    <div style={{ ...fw.expenseCard, marginBottom: 8 }}>
      <div style={{ ...fw.expenseTop, alignItems: "flex-start" }} onClick={() => setExpanded((o) => !o)} role="button">
        <div style={{ ...fw.splitDot, background: SPLIT_COLORS[split], marginTop: 5 }} />
        <div style={{ ...fw.expenseInfo }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <p style={{ ...fw.expenseDesc, margin: 0 }}>{description}</p>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#7B5EA7", background: "#EDE7DC", borderRadius: 6, padding: "2px 6px", flexShrink: 0 }}>
              {items.length} installment{items.length !== 1 ? "s" : ""}
            </span>
          </div>
          <p style={{ ...fw.expenseMeta, marginTop: 3 }}>{paidCount}/{items.length} paid</p>
          <div style={{ width: "100%", height: 4, borderRadius: 999, background: "#F3EDF8", marginTop: 6, overflow: "hidden" }}>
            <div style={{ width: `${Math.round(pct * 100)}%`, height: "100%", background: allPaid ? "#A6B49E" : anyOverdue ? "#E05C6E" : "#A6B7CB", borderRadius: 999, transition: "width 0.3s" }} />
          </div>
          {nextDueDate && !allPaid && (
            <p style={{ fontSize: 10, fontWeight: 700, margin: "4px 0 0", color: nextDueOverdue ? "#E05C6E" : "#A6B7CB" }}>
              {nextDueOverdue ? "Overdue · " : "Next due · "}{formatShortDate(nextDueDate)}
            </p>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <p style={{ ...fw.expenseTotal, margin: 0 }}>${totalCharged.toFixed(2)}</p>
          {!allPaid && remaining > 0.005 && (
            <p style={{ fontSize: 10, color: "#E05C6E", fontWeight: 700, margin: "3px 0 0" }}>${remaining.toFixed(2)} left</p>
          )}
          {allPaid && (
            <span style={{ fontSize: 10, fontWeight: 700, color: "#2D5A4A", background: "#EBF0E8", borderRadius: 6, padding: "2px 6px", marginTop: 3, display: "inline-block" }}>✓ Done</span>
          )}
        </div>
      </div>

      {expanded && (
        <div style={{ borderTop: "1px solid #EEE9E0", padding: "2px 14px 10px" }}>
          {items.map((e, i) => (
            <GroupSubRow
              key={e.id}
              expense={e}
              user={user}
              onMarkPaid={onMarkPaid}
              onEdit={onEdit}
              isLast={i === items.length - 1}
            />
          ))}
          {isCam && !allPaid && remaining > 0.005 && typeof onLogPaymentForKey === "function" && (
            <div style={{ marginTop: 10 }}>
              <QuickPayButtons
                targetKey={`grp:${gid}`}
                myShare={remaining}
                remaining={remaining}
                onLogPaymentForKey={onLogPaymentForKey}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── EXPENSE ROW ───────────────────────────────────────────────────────
function ExpenseRow({ expense, user, onDelete, onEdit, onMarkPaid, targetSummaries, payments, onLogPaymentForKey, onDispute }) {
  return (
    <ExpandableExpenseRow
      expense={expense}
      user={user}
      onDelete={onDelete}
      onEdit={onEdit}
      onMarkPaid={onMarkPaid}
      targetSummaries={targetSummaries}
      payments={payments}
      onLogPaymentForKey={onLogPaymentForKey}
      onDispute={onDispute}
    />
  );
}


// ── QUICK PAY BUTTONS ─────────────────────────────────────────────────
function QuickPayButtons({ targetKey, myShare, remaining, onLogPaymentForKey }) {
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customVal, setCustomVal] = useState("");

  function submitCustom() {
    const amt = parseFloat(customVal);
    if (!amt || amt <= 0) return;
    setOpen(false);
    setCustomMode(false);
    setCustomVal("");
    onLogPaymentForKey(targetKey, amt);
  }

  if (!open) {
    return (
      <button type="button" style={fw.logPayBtn} onClick={() => setOpen(true)}>
        Log a payment
      </button>
    );
  }

  if (customMode) {
    return (
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <span style={{ position: "absolute", left: 12, fontWeight: 700, color: "#00314B", fontSize: 16, pointerEvents: "none" }}>$</span>
          <input
            autoFocus
            type="number"
            min="0.01"
            step="0.01"
            placeholder="0.00"
            value={customVal}
            onChange={(e) => setCustomVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCustom();
              if (e.key === "Escape") { setCustomMode(false); setCustomVal(""); }
            }}
            style={{ width: "100%", padding: "12px 80px 12px 28px", borderRadius: 12, border: "1.5px solid #D5BD96", fontSize: 18, fontWeight: 700, color: "#00314B", outline: "none", boxSizing: "border-box", background: "#F5F1EB" }}
          />
          <button
            type="button"
            onClick={submitCustom}
            style={{ position: "absolute", right: 8, padding: "6px 14px", borderRadius: 9, border: "none", background: "linear-gradient(135deg, #D5BD96, #7A9BB5)", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer" }}
          >
            Next →
          </button>
        </div>
        <button
          type="button"
          style={{ background: "none", border: "none", color: "#AAA", fontSize: 12, cursor: "pointer", padding: "2px 0" }}
          onClick={() => { setCustomMode(false); setCustomVal(""); }}
        >
          ← Back
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          style={{ flex: 1, padding: "10px 8px", borderRadius: 12, border: "none", background: "linear-gradient(135deg, #A6B49E, #4E635E)", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", lineHeight: 1.2 }}
          onClick={() => { setOpen(false); onLogPaymentForKey(targetKey, myShare); }}
        >
          Pay My Share{"\n"}
          <span style={{ fontSize: 13, fontWeight: 900 }}>${Number(myShare).toFixed(2)}</span>
        </button>
        <button
          type="button"
          style={{ flex: 1, padding: "10px 8px", borderRadius: 12, border: "none", background: "linear-gradient(135deg, #D5BD96, #7A9BB5)", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", lineHeight: 1.2 }}
          onClick={() => { setOpen(false); onLogPaymentForKey(targetKey, remaining); }}
        >
          Pay Remaining{"\n"}
          <span style={{ fontSize: 13, fontWeight: 900 }}>${Number(remaining).toFixed(2)}</span>
        </button>
        <button
          type="button"
          style={{ flex: 1, padding: "10px 8px", borderRadius: 12, border: "1.5px solid #DDD5C5", background: "#EEE9E0", color: "#00314B", fontWeight: 700, fontSize: 12, cursor: "pointer", lineHeight: 1.2 }}
          onClick={() => setCustomMode(true)}
        >
          Custom{"\n"}
          <span style={{ fontSize: 13, fontWeight: 900 }}>Amount</span>
        </button>
      </div>
      <button
        type="button"
        style={{ background: "none", border: "none", color: "#AAA", fontSize: 12, cursor: "pointer", padding: "2px 0" }}
        onClick={() => setOpen(false)}
      >
        Cancel
      </button>
    </div>
  );
}

// ── SPLITTRACK FRAMEWORK COMPONENTS (imported) ───────────────────────

function ExpandableExpenseRow({ expense: e, user, onDelete, onEdit, onMarkPaid, targetSummaries, payments, onLogPaymentForKey, onDispute }) {
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

  // Sync local note state when the expense prop updates from Firestore
  useEffect(() => {
    if (!editingNote) {
      setNote(e.note || "");
      setNoteDraft(e.note || "");
    }
  }, [e.note]); // eslint-disable-line react-hooks/exhaustive-deps

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
      ? "#A6B49E"
      : camIsCredit
        ? "#A6B49E"
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
    <motion.div
      layout
      style={{
        ...fw.expenseCard,
        opacity: e._deleting ? 0.55 : e._marking ? 0.75 : 1,
        pointerEvents: e._deleting || e._marking ? "none" : "auto",
        border: isCam ? "1.5px solid #EDE7DC" : fw.expenseCard.border,
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
          {(() => {
            const due = e.nextDue || e.dueDate;
            if (!due) return null;
            const isOverdue = getUrgencyLevel(e) === "overdue";
            const isPaid = e.status === "paid";
            return (
              <p style={{ fontSize: 10, fontWeight: 700, margin: "4px 0 0", color: isOverdue ? "#E05C6E" : isPaid ? "#B0B0B0" : "#A6B7CB" }}>
                {isOverdue ? "Overdue · " : isPaid ? "Was due · " : "Due · "}{formatShortDate(due)}
              </p>
            );
          })()}
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
          ? "#EBF0E8"
          : camStatusLabel === "Overdue"
            ? "#FFF0F0"
            : "#FBEFF5",
      color:
        camStatusLabel === "Paid" || camStatusLabel === "Credit"
          ? "#2D5A4A"
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
              color={expanded ? "#00314B" : "#CCC"}
            />
          </div>
        </div>
      </div>

      <AnimatePresence initial={false}>
      {expanded && (
        <motion.div
          key="expand"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 25, opacity: { duration: 0.15 } }}
          style={{ overflow: "hidden" }}
        >
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
                      <div style={{ ...fw.payMetaVal, color: "#2D5A4A" }}>${Math.abs(tPaid).toFixed(2)}</div>
                    </div>

                    <div style={fw.payMetaDivider} />

                    <div style={fw.payMetaStat}>
                      <div style={fw.payMetaLabel}>Remaining</div>
                      <div style={{ ...fw.payMetaVal, color: tRemaining > 0.005 ? "#E05C6E" : "#2D5A4A" }}>${Math.max(0, tRemaining).toFixed(2)}</div>
                    </div>

                    <div style={fw.payMetaDivider} />

                    <div style={fw.payMetaStat}>
                      <div style={fw.payMetaLabel}>Your share</div>
                      <div style={fw.payMetaVal}>${Math.abs(tCharged).toFixed(2)}</div>
                    </div>
                  </div>

                  {e.split === "split" && (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, paddingTop: 8, borderTop: "1px solid #EDE7DC" }}>
                      <span style={{ fontSize: 11, color: "#BBB", fontWeight: 600 }}>Full expense (50/50 split)</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#AAA" }}>${Number(e.amount || 0).toFixed(2)}</span>
                    </div>
                  )}

                  {tRemaining > 0.005 ? (
                    <QuickPayButtons
                      targetKey={targetKey}
                      myShare={suggested}
                      remaining={tRemaining}
                      onLogPaymentForKey={onLogPaymentForKey}
                    />
                  ) : (
  <div
    style={{
      ...fw.logPayBtn,
      background: "#EBF0E8",
      color: "#2D5A4A",
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

          {(() => {
            const isRecurring = e.recurring && e.recurring !== "none";
            const targetKey = isRecurring ? `grp:${e.groupId || e.id}` : `exp:${e.id}`;
            const confirmed = (payments || []).filter(p => {
              if (!p?.confirmed) return false;
              const key = p.appliedToKey || (p.appliedToGroupId ? `grp:${p.appliedToGroupId}` : "general");
              return key === targetKey;
            }).sort((a, b) => new Date(b.date) - new Date(a.date));
            if (!confirmed.length) return null;
            return (
              <div style={{ marginTop: 10, background: "#F4FBF7", borderRadius: 12, padding: "10px 12px" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#2D5A4A", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Confirmed Payments</div>
                {confirmed.map((p, i) => (
                  <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: i > 0 ? 6 : 0, borderTop: i > 0 ? "1px solid #E0F0E8" : "none" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#222" }}>via {p.method}</span>
                      <span style={{ fontSize: 11, color: "#888" }}>{formatShortDate(p.date)}</span>
                      {p.note && renderNote(p.note, { fontSize: 11, color: "#888", marginTop: 1 })}
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#2D5A4A" }}>-${Number(p.amount || 0).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            );
          })()}

          <div style={{ marginTop: 8 }}>
            <span style={fw.detailLabel}>Note</span>

            {editingNote ? (
              <div style={{ marginTop: 4 }}>
                <textarea
                  style={fw.noteTextarea}
                  value={noteDraft}
                  onChange={(ev) => {
                    // Auto-convert "- " at start of a line to a bullet
                    const val = ev.target.value.replace(/(^|\n)- /g, "$1• ");
                    setNoteDraft(val);
                  }}
                  placeholder={"Add a note…\n• Start a line with - for bullets"}
                  rows={3}
                  autoFocus
                  onKeyDown={(ev) => {
                    const isSave = (ev.ctrlKey || ev.metaKey) && ev.key === "Enter";
                    if (isSave) {
                      ev.preventDefault();
                      handleSaveNote(String(noteDraft || ""));
                    }
                    // Continue bullet on Enter if current line starts with •
                    if (ev.key === "Enter") {
                      const ta = ev.target;
                      const before = noteDraft.slice(0, ta.selectionStart);
                      const currentLine = before.split("\n").pop();
                      if (currentLine.startsWith("• ")) {
                        ev.preventDefault();
                        const after = noteDraft.slice(ta.selectionEnd);
                        const next = before + "\n• " + after;
                        setNoteDraft(next);
                        requestAnimationFrame(() => {
                          ta.selectionStart = ta.selectionEnd = before.length + 3;
                        });
                      }
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
                          ? "#2D5A4A"
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
                <div
                  style={{ ...fw.noteTap, fontStyle: note ? "normal" : "italic" }}
                  onClick={() => {
                    setNoteDraft(note);
                    setEditingNote(true);
                  }}
                >
                  {note ? renderNote(note) : "Tap to add a note…"}
                </div>

                {noteSaveStatus === "saved" && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#2D5A4A",
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

          {typeof onEdit === "function" && user !== "cam" && (
            <button
              type="button"
              style={{ width: "100%", marginTop: 8, padding: "9px", borderRadius: 12, border: "1.5px solid #DDD5C5", background: "#EEE9E0", color: "#00314B", fontWeight: 700, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              onClick={() => onEdit(e)}
            >
              <Icon path={icons.edit} size={15} color="#00314B" />
              Edit Expense
            </button>
          )}

          {user === "cam" && typeof onDispute === "function" && e.status !== "paid" && (
            <button
              type="button"
              style={{ width: "100%", marginTop: 8, padding: "9px", borderRadius: 12, border: "1.5px solid #F8C4CD", background: "#FFF5F6", color: "#E05C6E", fontWeight: 700, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              onClick={() => onDispute(e)}
            >
              <Icon path={icons.flag} size={15} color="#E05C6E" />
              Dispute Charge
            </button>
          )}

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
        </motion.div>
      )}
      </AnimatePresence>
    </motion.div>
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
        <Icon path={icons.search} size={16} color="#00314B" />
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


// ── ADD EXPENSE MODAL ─────────────────────────────────────────────────
function AddExpenseModal({ onSave, onClose, user }) {
  const todayStr = new Date().toISOString().split("T")[0];
  const [form, setForm] = useState({
    description: "",
    amount: "",
    split: "split",
    date: todayStr,
    dueDate: "",
    endDate: "",
    account: "Navy Platinum",
    category: "Groceries",
    recurring: "none",
    mandatory: false,
    note: "",
    referenceNum: "",
  });
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const previewNextDue =
    form.recurring && form.recurring !== "none" && form.dueDate
      ? getNextDueDate(form.dueDate, form.recurring)
      : "";
  const isToday = form.date === todayStr;
  const dateDisplay = isToday
    ? `Today · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : new Date(form.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  const isRecurring = form.recurring && form.recurring !== "none";

  const groupCard = {
    borderRadius: 16,
    border: "1.5px solid #EDE7DC",
    background: "#FAFBFF",
    padding: "14px 14px 10px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  };
  const groupLabel = (text, color, badge) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
      <span style={{ fontSize: 10, fontWeight: 800, color, textTransform: "uppercase", letterSpacing: 1.1 }}>{text}</span>
      {badge}
    </div>
  );

  const splitOptions = user === "cam"
    ? [["cam", "I pay", "#E8A0B0"], ["ella", "Emmanuella pays", "#A6B49E"], ["split", "Split 50/50", "#D5BD96"]]
    : [["mine", "I pay", "#A6B49E"], ["cam", "Cam pays", "#E8A0B0"], ["split", "Split 50/50", "#D5BD96"]];

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

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* ── Templates ── */}
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2, WebkitOverflowScrolling: "touch", scrollbarWidth: "none", msOverflowStyle: "none" }}>
            {EXPENSE_TEMPLATES.map((t) => (
              <button
                key={t.label}
                type="button"
                style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 999, border: "1.5px solid #DDD5C5", background: "#EEE9E0", fontSize: 12, fontWeight: 700, color: "#00314B", cursor: "pointer", whiteSpace: "nowrap" }}
                onClick={() => setForm(f => ({ ...f, description: t.description, category: t.category, recurring: t.recurring, split: t.split, ...(t.amount ? { amount: t.amount } : {}) }))}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* ── Group 1: WHAT ── */}
          <div style={groupCard}>
            {groupLabel("What", "#A6B7CB")}

            <input
              style={{ ...styles.input, fontSize: 16, fontWeight: 600 }}
              placeholder="Description — e.g. Netflix, Wegmans…"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />

            <div style={{ display: "flex", gap: 7, overflowX: "auto", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", msOverflowStyle: "none", paddingBottom: 2, margin: "0 -14px", padding: "0 14px 2px" }}>
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  style={{
                    flexShrink: 0, padding: "6px 14px", borderRadius: 999, border: "1.5px solid",
                    background: form.category === c ? "#00314B" : "#EEE9E0",
                    color: form.category === c ? "#fff" : "#666",
                    borderColor: form.category === c ? "#00314B" : "#DDD5C5",
                    fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
                  }}
                  onClick={() => set("category", c)}
                >
                  {c}
                </button>
              ))}
            </div>

            {/* Extra details — inline below category */}
            <div>
              <button
                type="button"
                onClick={() => setShowNotes(p => !p)}
                style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer", padding: "2px 0", color: showNotes ? "#1B4D6B" : "#BBB" }}
              >
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                  <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                  <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
                </svg>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{showNotes ? "Hide details" : "Add details"}</span>
                <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" style={{ transform: showNotes ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>

              {showNotes && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                  {/* Reference number */}
                  <div style={{ position: "relative" }}>
                    <div style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", display: "flex", alignItems: "center", pointerEvents: "none" }}>
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#D5BD96" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
                        <line x1="7" y1="7" x2="7.01" y2="7"/>
                      </svg>
                    </div>
                    <input
                      autoFocus
                      placeholder="Reference # — e.g. TXN-4821, Order ID…"
                      value={form.referenceNum}
                      onChange={(e) => set("referenceNum", e.target.value)}
                      style={{ display: "block", width: "100%", boxSizing: "border-box", padding: "11px 14px 11px 34px", borderRadius: 12, border: "1.5px solid #DDD5C5", background: "#F5F1EB", fontSize: 13, fontWeight: 600, color: "#00314B", fontFamily: "inherit", outline: "none" }}
                    />
                  </div>

                  {/* Notes */}
                  <textarea
                    placeholder="Extra context, links, reminders…"
                    value={form.note}
                    onChange={(e) => set("note", e.target.value)}
                    style={{ display: "block", width: "100%", boxSizing: "border-box", padding: "11px 14px", borderRadius: 12, border: "1.5px solid #DDD5C5", background: "#F5F1EB", fontSize: 13, fontWeight: 500, color: "#00314B", fontFamily: "inherit", outline: "none", resize: "none", minHeight: 72, lineHeight: 1.5 }}
                  />
                </div>
              )}
            </div>
          </div>

          {/* ── Group 2: HOW MUCH ── */}
          <div style={groupCard}>
            {groupLabel("How Much", "#1B4D6B")}
            <div style={{ position: "relative", width: "100%" }}>
              <span style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", fontSize: 26, fontWeight: 800, color: "#D5BD96", pointerEvents: "none" }}>$</span>
              <input
                style={{ display: "block", width: "100%", boxSizing: "border-box", height: 64, paddingLeft: 44, paddingRight: 14, borderRadius: 12, border: "1.5px solid #DDD5C5", background: "#F5F1EB", outline: "none", fontSize: 34, fontWeight: 800, color: "#00314B", letterSpacing: -0.5, fontFamily: "inherit" }}
                type="number"
                inputMode="decimal"
                placeholder="0.00"
                value={form.amount}
                onChange={(e) => set("amount", e.target.value)}
              />
            </div>
          </div>

          {/* ── Group 3: WHO PAYS ── */}
          <div style={groupCard}>
            {groupLabel("Who Pays", "#C0485A")}

            <LiquidSegmented
              options={splitOptions.map(([v, l]) => [v, l])}
              value={form.split}
              onChange={(v) => set("split", v)}
              containerStyle={{ background: "rgba(0,49,75,0.08)" }}
              activeColor="#00314B"
              inactiveColor="#888"
            />

            <div>
              <label style={{ ...styles.fieldLabel, marginBottom: 5 }}>Charged to</label>
              <select style={styles.input} value={form.account} onChange={(e) => set("account", e.target.value)}>
                {["Navy Platinum", "Best Buy Visa", "Debit Card", "Klarna", "Affirm", "Cash", "Zelle"].map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </div>
          </div>

          {/* ── Group 4: WHEN ── */}
          <div style={groupCard}>
            {groupLabel("When", "#A6B49E", isRecurring ? <span style={styles.newBadge}>RECURRING</span> : null)}

            {/* Transaction date — defaults to today, expandable to pick another */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {!isToday && <div style={{ width: 7, height: 7, borderRadius: 999, background: "#E05C6E", flexShrink: 0 }} />}
                <span style={{ fontSize: 14, fontWeight: 700, color: isToday ? "#00314B" : "#E05C6E" }}>{dateDisplay}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (showDatePicker && !isToday) set("date", todayStr);
                  setShowDatePicker(p => !p);
                }}
                style={{ fontSize: 12, fontWeight: 700, color: "#A6B7CB", background: "none", border: "none", cursor: "pointer", padding: "4px 0" }}
              >
                {showDatePicker ? (isToday ? "Done" : "Reset to today") : "Different date"}
              </button>
            </div>
            {showDatePicker && (
              <input
                style={styles.input}
                type="date"
                value={form.date}
                max={todayStr}
                onChange={(e) => set("date", e.target.value)}
              />
            )}

            {/* Frequency */}
            <div>
              <label style={styles.fieldLabel}>Frequency</label>
              <div style={{ display: "flex", gap: 6 }}>
                {[["none", "One-time"], ["weekly", "Weekly"], ["biweekly", "Biweekly"], ["monthly", "Monthly"]].map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    style={{ ...styles.freqBtn, ...(form.recurring === val ? styles.freqBtnActive : {}) }}
                    onClick={() => set("recurring", val)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* One-time: optional due date */}
            {!isRecurring && (
              <div>
                <label style={styles.fieldLabel}>Due date (optional)</label>
                <input style={styles.input} type="date" value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
              </div>
            )}

            {/* Recurring: start + end side by side, then auto-advance preview */}
            {isRecurring && (
              <div style={{ background: "#F0EAE0", borderRadius: 12, padding: "12px 12px 10px", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={styles.twoCol}>
                  <div style={{ flex: 1 }}>
                    <label style={styles.fieldLabel}>Start date</label>
                    <input style={styles.input} type="date" value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={styles.fieldLabel}>End date (optional)</label>
                    <input style={styles.input} type="date" value={form.endDate} min={form.dueDate || undefined} onChange={(e) => set("endDate", e.target.value)} />
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 2 }}>
                  <span style={{ fontSize: 12, color: "#AAA", fontWeight: 500 }}>Auto-advances to</span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: previewNextDue ? "#1B4D6B" : "#CCC" }}>
                    {previewNextDue ? formatHistoryDate(previewNextDue) : "set start date first"}
                  </span>
                </div>
              </div>
            )}

            {/* Mandatory toggle */}
            <button
              type="button"
              onClick={() => set("mandatory", !form.mandatory)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "10px 12px", borderRadius: 12, border: "1.5px solid",
                borderColor: form.mandatory ? "#E05C6E" : "#DDD5C5",
                background: form.mandatory ? "#FFF5F6" : "#FAFBFF",
                cursor: "pointer", width: "100%", textAlign: "left",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <svg width={15} height={15} viewBox="0 0 24 24" fill={form.mandatory ? "#E05C6E" : "#CCC"}>
                  <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
                </svg>
                <div>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: form.mandatory ? "#E05C6E" : "#00314B" }}>Mandatory</p>
                  <p style={{ margin: 0, fontSize: 11, color: "#AAA" }}>Cannot be late — alerts Cameron earlier</p>
                </div>
              </div>
              <div style={{
                width: 36, height: 20, borderRadius: 999, background: form.mandatory ? "#E05C6E" : "#DDD",
                position: "relative", transition: "background 0.2s", flexShrink: 0,
              }}>
                <div style={{
                  position: "absolute", top: 2, left: form.mandatory ? 18 : 2,
                  width: 16, height: 16, borderRadius: "50%", background: "#fff",
                  transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                }} />
              </div>
            </button>
          </div>

          {/* ── Save ── */}
          <button
            style={{ ...styles.saveBtn, opacity: (!form.description || !form.amount) ? 0.45 : 1 }}
            onClick={() => {
              if (!form.description || !form.amount) return;
              const data = {
                ...form,
                amount: parseFloat(form.amount),
                nextDue: form.dueDate || null,
              };
              if (!data.dueDate) delete data.dueDate;
              if (!data.endDate) delete data.endDate;
              if (!data.note) delete data.note;
              if (!data.referenceNum) delete data.referenceNum;
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
// ── QUICK ADD MODAL ───────────────────────────────────────────────────
function QuickAddModal({ user, onSave, onClose }) {
  const isCam = user === "cam";
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [split, setSplit] = useState("split");

  const splitOptions = isCam
    ? [["cam", "I pay"], ["ella", "Emmanuella pays"], ["split", "Split"]]
    : [["mine", "I pay"], ["cam", "Cam pays"], ["split", "Split"]];

  function handleSave() {
    const amt = parseFloat(amount);
    if (!amt || !description.trim()) return;
    onSave({
      description: description.trim(),
      amount: amt,
      split,
      date: new Date().toISOString().split("T")[0],
      recurring: "none",
      category: "Other",
      account: "Navy Platinum",
    });
  }

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(20,10,40,0.45)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}
      onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}
    >
      <div style={{ background: "#fff", borderRadius: "24px 24px 0 0", padding: "20px 20px 36px", boxShadow: "0 -8px 40px rgba(0,0,0,0.18)" }}>
        <div style={{ width: 36, height: 4, borderRadius: 99, background: "#E0D8F0", margin: "0 auto 20px" }} />

        {/* Amount — big, keyboard-first */}
        <div style={{ position: "relative", marginBottom: 12 }}>
          <span style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", fontSize: 28, fontWeight: 800, color: "#D5BD96", pointerEvents: "none" }}>$</span>
          <input
            autoFocus
            inputMode="decimal"
            type="number"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && document.getElementById("qa-desc")?.focus()}
            style={{ width: "100%", boxSizing: "border-box", paddingLeft: 44, paddingRight: 16, height: 64, borderRadius: 16, border: "2px solid #DDD5C5", background: "#F5F1EB", fontSize: 32, fontWeight: 800, color: "#00314B", fontFamily: "inherit", outline: "none" }}
          />
        </div>

        {/* Description */}
        <input
          id="qa-desc"
          placeholder="What's this for?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
          style={{ width: "100%", boxSizing: "border-box", padding: "14px 16px", borderRadius: 14, border: "1.5px solid #DDD5C5", background: "#F5F1EB", fontSize: 16, fontWeight: 600, color: "#00314B", fontFamily: "inherit", outline: "none", marginBottom: 14 }}
        />

        {/* Split chips */}
        <div style={{ marginBottom: 18 }}>
          <LiquidSegmented
            options={splitOptions}
            value={split}
            onChange={setSplit}
            containerStyle={{ background: "rgba(0,49,75,0.08)" }}
            activeColor="#00314B"
            inactiveColor="#888"
          />
        </div>

        {/* Save */}
        <button
          type="button"
          disabled={!amount || !description.trim()}
          onClick={handleSave}
          style={{ width: "100%", padding: "16px", borderRadius: 16, border: "none", background: amount && description.trim() ? "linear-gradient(135deg, #A6B49E, #4E635E)" : "#DDD5C5", color: amount && description.trim() ? "#fff" : "#BBB", fontWeight: 800, fontSize: 16, fontFamily: "inherit", cursor: amount && description.trim() ? "pointer" : "default", transition: "background 0.15s" }}
        >
          Add Expense
        </button>
      </div>
    </div>
  );
}

// ── EDIT EXPENSE MODAL ────────────────────────────────────────────────
function EditExpenseModal({ expense, onSave, onDelete, onClose }) {
  const isRecurring = expense.recurring && expense.recurring !== "none";
  const [form, setForm] = useState({
    description: expense.description || "",
    amount: expense.amount != null ? String(expense.amount) : "",
    date: expense.date || new Date().toISOString().split("T")[0],
    dueDate: expense.dueDate || expense.nextDue || "",
    endDate: expense.endDate || "",
    recurring: expense.recurring || "none",
    referenceNum: expense.referenceNum || "",
    account: expense.account || "Navy Platinum",
    note: expense.note || "",
    mandatory: expense.mandatory || false,
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const recurring = form.recurring && form.recurring !== "none";

  return (
    <div style={styles.modalOverlay}>
      <div style={styles.modal}>
        <div style={styles.dragHandle} />

        <div style={styles.modalHeader}>
          <h3 style={styles.modalTitle}>Edit Expense</h3>
          <button style={styles.closeBtn} onClick={onClose}>
            <Icon path={icons.x} size={18} color="#C0485A" />
          </button>
        </div>

        <div style={styles.form}>
          <label style={styles.fieldLabel}>Name</label>
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

          <label style={styles.fieldLabel}>Transaction date</label>
          <input
            style={styles.input}
            type="date"
            value={form.date}
            onChange={(e) => set("date", e.target.value)}
          />

          <label style={styles.fieldLabel}>Frequency</label>
          <div style={styles.chipRow}>
            {[["none", "One-time"], ["weekly", "Weekly"], ["biweekly", "Biweekly"], ["monthly", "Monthly"]].map(([val, label]) => (
              <button
                key={val}
                type="button"
                style={{ ...styles.freqBtn, ...(form.recurring === val ? styles.freqBtnActive : {}) }}
                onClick={() => set("recurring", val)}
              >
                {label}
              </button>
            ))}
          </div>

          {!recurring ? (
            <>
              <label style={styles.fieldLabel}>Due date (optional)</label>
              <input
                style={styles.input}
                type="date"
                value={form.dueDate}
                onChange={(e) => set("dueDate", e.target.value)}
              />
            </>
          ) : (
            <div style={styles.dueDateBox}>
              <div style={styles.twoCol}>
                <div style={{ flex: 1 }}>
                  <label style={styles.fieldLabel}>{isRecurring ? "Next due date" : "First due date"}</label>
                  <input
                    style={styles.input}
                    type="date"
                    value={form.dueDate}
                    onChange={(e) => set("dueDate", e.target.value)}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={styles.fieldLabel}>End date (optional)</label>
                  <input
                    style={styles.input}
                    type="date"
                    value={form.endDate}
                    min={form.dueDate || undefined}
                    onChange={(e) => set("endDate", e.target.value)}
                  />
                </div>
              </div>
              <p style={styles.hintText}>Stops repeating when end date is reached.</p>
            </div>
          )}

          <div style={styles.twoCol}>
            <div style={{ flex: 1 }}>
              <label style={styles.fieldLabel}>Reference # (optional)</label>
              <input
                style={styles.input}
                placeholder="TXN-4821"
                value={form.referenceNum}
                onChange={(e) => set("referenceNum", e.target.value)}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={styles.fieldLabel}>Source of payment</label>
              <select style={styles.input} value={form.account} onChange={(e) => set("account", e.target.value)}>
                {["Navy Platinum", "Best Buy Visa", "Debit Card", "Klarna", "Affirm", "Cash", "Zelle"].map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </div>
          </div>

          <label style={styles.fieldLabel}>Notes</label>
          <textarea
            style={{ ...styles.input, minHeight: 60, resize: "vertical", lineHeight: 1.4 }}
            placeholder="Any extra details…"
            value={form.note}
            onChange={(e) => set("note", e.target.value)}
          />

          {/* Mandatory toggle */}
          <button
            type="button"
            onClick={() => set("mandatory", !form.mandatory)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "10px 12px", borderRadius: 12, border: "1.5px solid",
              borderColor: form.mandatory ? "#E05C6E" : "#DDD5C5",
              background: form.mandatory ? "#FFF5F6" : "#FAFBFF",
              cursor: "pointer", width: "100%", textAlign: "left", marginBottom: 4,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <svg width={15} height={15} viewBox="0 0 24 24" fill={form.mandatory ? "#E05C6E" : "#CCC"}>
                <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
              </svg>
              <div>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: form.mandatory ? "#E05C6E" : "#00314B" }}>Mandatory</p>
                <p style={{ margin: 0, fontSize: 11, color: "#AAA" }}>Cannot be late — alerts Cameron earlier</p>
              </div>
            </div>
            <div style={{
              width: 36, height: 20, borderRadius: 999, background: form.mandatory ? "#E05C6E" : "#DDD",
              position: "relative", transition: "background 0.2s", flexShrink: 0,
            }}>
              <div style={{
                position: "absolute", top: 2, left: form.mandatory ? 18 : 2,
                width: 16, height: 16, borderRadius: "50%", background: "#fff",
                transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              }} />
            </div>
          </button>

          <button
            style={styles.saveBtn}
            type="button"
            onClick={() => {
              if (!form.description || !form.amount) return;
              const updates = {
                description: form.description,
                amount: parseFloat(form.amount),
                date: form.date || null,
                recurring: form.recurring,
                referenceNum: form.referenceNum || null,
                account: form.account,
                note: form.note,
                mandatory: form.mandatory,
                endDate: recurring ? (form.endDate || null) : null,
              };
              if (form.dueDate) {
                updates.dueDate = form.dueDate;
                updates.nextDue = form.dueDate;
              }
              onSave(expense.id, updates);
            }}
          >
            Save Changes
          </button>

          {typeof onDelete === "function" && (
            <button
              type="button"
              style={{ width: "100%", marginTop: 8, padding: "12px", borderRadius: 14, border: "1.5px solid #F5D0D6", background: "#FFF5F6", color: "#C0485A", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}
              onClick={() => onDelete(expense.id)}
            >
              Delete Expense
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

//
// ★ CHANGE 4: Fixed LogPaymentModal — defaultAppliedToKey → initialAppliedToKey, added set() helper, added selectedTarget
//
function LogPaymentModal({ balance, onSave, onClose, user, targets = [], planSummaries, targetSummaries, initialAppliedToKey, initialAmount }) {
  const [form, setForm] = useState({
    amount: initialAmount != null ? String(Number(initialAmount).toFixed(2)) : "",
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
  // ── Simplified quick-pay flow (amount already chosen) ──────────────
  if (initialAmount != null) {
    return (
      <div style={styles.modalOverlay}>
        <div style={styles.modal}>
          <div style={styles.dragHandle} />
          <div style={styles.modalHeader}>
            <h3 style={styles.modalTitle}>How did you pay?</h3>
            <button style={styles.closeBtn} onClick={onClose}><Icon path={icons.x} size={18} color="#C0485A" /></button>
          </div>

          {/* What this payment is going toward */}
          {selectedTarget && (
            <div style={{ background: "#EAF0F8", borderRadius: 11, padding: "10px 14px", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center", border: "1.5px solid #C8DCF0" }}>
              <span style={{ fontSize: 11, color: "#5A7A9A", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Applying to</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: "#00314B", textAlign: "right", maxWidth: "65%" }}>{selectedTarget.label}</span>
            </div>
          )}

          <div style={{ background: "#EEE9E0", borderRadius: 14, padding: "14px 16px", marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "#888", fontWeight: 600 }}>Amount</span>
            <span style={{ fontSize: 22, fontWeight: 900, color: "#00314B" }}>${Number(initialAmount).toFixed(2)}</span>
          </div>

          <div style={styles.splitRow}>
            {["Zelle", "Cash App", "Venmo", "Cash", "Apple Pay"].map(m => (
              <button key={m} style={{
                ...styles.splitOption,
                fontSize: 12,
                background: form.method === m ? "#A6B49E" : "#EEE9E0",
                color: form.method === m ? "#fff" : "#666",
                fontWeight: form.method === m ? 700 : 400,
              }} onClick={() => set("method", m)}>{m}</button>
            ))}
          </div>

          {user === "cam" && <p style={{...styles.formNote, marginTop: 16}}>⚠️ Emmanuella will confirm once she receives it</p>}

          <button
            style={{ ...styles.saveBtn, background: "linear-gradient(135deg, #A6B49E, #4E635E)", marginTop: 20 }}
            onClick={() => {
              const key = form.appliedToKey || "general";
              const legacyGroupId = key.startsWith("grp:") ? key.slice(4) : undefined;
              onSave({
                ...form,
                amount: Number(initialAmount),
                appliedToKey: key,
                ...(legacyGroupId ? { appliedToGroupId: legacyGroupId } : {}),
              });
            }}
          >
            Done
          </button>
        </div>
      </div>
    );
  }

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
                style={{ background: "none", border: "none", color: "#A6B49E", fontWeight: 700, cursor: "pointer", fontSize: 12 }}
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
                background: form.method === m ? "#A6B49E" : "#EEE9E0",
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

          <button style={{...styles.saveBtn, background: "linear-gradient(135deg, #A6B49E, #4E635E)"}} onClick={() => {
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

// ── LIQUID GLASS SEGMENTED SELECTOR ──────────────────────────────────
function LiquidSegmented({ options, value, onChange, containerStyle, itemStyle, activeColor, inactiveColor }) {
  const containerRef = useRef(null);
  const [pill, setPill] = useState({ left: 0, width: 0 });
  const [settling, setSettling] = useState(false);
  const prevValue = useRef(value);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const idx = options.findIndex(o => (Array.isArray(o) ? o[0] : o) === value);
    const item = el.querySelectorAll('.lg-btn')[idx];
    if (!item) return;
    const cr = el.getBoundingClientRect();
    const ir = item.getBoundingClientRect();
    setPill({ left: ir.left - cr.left, width: ir.width });
    if (prevValue.current !== value) {
      setSettling(false);
      requestAnimationFrame(() => { setSettling(true); setTimeout(() => setSettling(false), 450); });
      prevValue.current = value;
    }
  }, [value, options]);

  return (
    <div ref={containerRef} style={{ position: "relative", display: "flex", borderRadius: 14, padding: "3px", background: "rgba(0,0,0,0.07)", gap: 0, ...containerStyle }}>
      <div className={`lg-pill${settling ? " lg-settle" : ""}`} style={{ left: pill.left, width: pill.width }} />
      {options.map(opt => {
        const [val, label] = Array.isArray(opt) ? opt : [opt, opt];
        const active = val === value;
        return (
          <button
            key={val}
            className="lg-btn"
            type="button"
            onClick={() => onChange(val)}
            style={{ flex: 1, padding: "9px 6px", borderRadius: 11, fontWeight: 700, fontSize: 13, color: active ? (activeColor || "#1A1A1A") : (inactiveColor || "#888"), ...itemStyle }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ── BOTTOM NAV ────────────────────────────────────────────────────────
function BottomNav({ screen, onNavigate, urgentCount = 0, hidden = false }) {
  const tabs = [
    { id: "dashboard", icon: icons.home, label: "Home" },
    { id: "expenses", icon: icons.list, label: "Expenses" },
    { id: "urgent", icon: icons.fire, label: "Urgent" },
    { id: "history", icon: icons.clock, label: "History" },
  ];
  const navRef = useRef(null);
  const [navPill, setNavPill] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const prevScreen = useRef(screen);

  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const idx = tabs.findIndex(t => t.id === screen);
    const btn = el.querySelectorAll("button")[idx];
    if (!btn) return;
    const nr = el.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    setNavPill({ left: br.left - nr.left + 4, top: br.top - nr.top + 4, width: br.width - 8, height: br.height - 8 });
    prevScreen.current = screen;
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  if (hidden) return null;
  return (
    <div ref={navRef} style={{ ...styles.bottomNav, position: "fixed", overflow: "hidden" }}>
      <div className="lg-nav-pill" style={{ left: navPill.left, top: navPill.top, width: navPill.width, height: navPill.height }} />
      {tabs.map(t => (
        <button
          key={t.id}
          className="lg-btn"
          style={{ ...styles.navBtn, position: "relative", zIndex: 1 }}
          onClick={() => onNavigate(t.id)}
        >
          <div style={{ position: "relative", transition: "transform 0.3s cubic-bezier(.34,1.56,.64,1)", transform: screen === t.id ? "scale(1.15) translateY(-1px)" : "scale(1)" }}>
            <Icon
              path={t.icon}
              size={20}
              color={
                screen === t.id
                  ? "#A6B49E"
                  : t.id === "urgent" && urgentCount > 0
                  ? "#E05C6E"
                  : "#AAA"
              }
            />
            {t.id === "urgent" && urgentCount > 0 && (
              <span style={{ position: "absolute", top: -4, right: -6, background: "#E05C6E", color: "#fff", borderRadius: 10, fontSize: 9, fontWeight: 800, padding: "1px 5px", minWidth: 14, textAlign: "center" }}>
                {urgentCount}
              </span>
            )}
          </div>
          <span style={{ fontSize: 10, transition: "color 0.22s ease, font-weight 0.22s ease", color: screen === t.id ? "#A6B49E" : t.id === "urgent" && urgentCount > 0 ? "#E05C6E" : "#AAA", fontWeight: screen === t.id ? 700 : 400 }}>
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
  expenseDesc: { fontSize: 13, fontWeight: 600, color: "#00314B", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  expenseMeta: { fontSize: 11, color: "#999", margin: "2px 0 0" },
  expenseRight: { textAlign: "right", flexShrink: 0 },
  expenseTotal: { fontSize: 14, fontWeight: 700, color: "#00314B", margin: 0 },
  expenseCam: { fontSize: 11, color: "#E8A0B0", margin: "1px 0 0", fontWeight: 600 },
  splitDot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  chevron: { display: "flex", alignItems: "center", justifyContent: "center", marginTop: 4 },
  deleteBtn: { flex: 1, padding: "9px", borderRadius: 12, border: "none", background: "#FFF0F0", color: "#C0485A", fontWeight: 700, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 },

// Payment plan UI (Cam view)
payPlanCard: {
  marginTop: 12,
  background: "#fff",
  borderRadius: 16,
  border: "1px solid #EDE7DC",
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
  color: "#00314B",
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
  border: "2px solid #DDD5C5",
  background: "#fff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
},
payPlanCircleDone: {
  border: "2px solid #A6B49E",
  background: "#A6B49E",
},
payPlanBarTrack: {
  height: 8,
  borderRadius: 999,
  background: "#EEE9E0",
  overflow: "hidden",
},
payPlanBarFill: {
  height: "100%",
  borderRadius: 999,
  background: "linear-gradient(135deg, #A6B49E, #4E635E)",
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
  color: "#00314B",
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
  border: "1px solid #EDE7DC",
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
  color: "#00314B",
},
payMetaDivider: {
  width: 1,
  background: "#EDE7DC",
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
  background: "linear-gradient(135deg, #D5BD96, #7A9BB5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  boxSizing: "border-box",
},

  expandPanel: { padding: "14px 16px 16px", borderTop: "1px solid #EEE9E0" },
  detailRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #F9F5FF" },
  detailLabel: { fontSize: 11, color: "#AAA", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 },
  detailVal: { fontSize: 13, color: "#00314B", fontWeight: 600 },
  statusBadge: { fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 8 },
  splitChip: { fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 8 },

  noteInput: { width: "100%", maxWidth: "100%", boxSizing: "border-box", display: "block", padding: "12px 14px", borderRadius: 14, border: "1.5px solid #DDD5C5", fontSize: 15, lineHeight: 1.4, fontFamily: "inherit", outline: "none", marginTop: 8, background: "#fff" },
  noteTextarea: { width: "100%", maxWidth: "100%", boxSizing: "border-box", display: "block", padding: "12px 14px", borderRadius: 14, border: "1.5px solid #DDD5C5", fontSize: 15, lineHeight: 1.45, fontFamily: "inherit", outline: "none", marginTop: 8, background: "#fff", resize: "vertical", minHeight: 84 },
  noteSaveBtn: { flex: 1, marginTop: 0, padding: "8px 16px", borderRadius: 12, border: "none", background: "#A6B49E", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer" },
  noteBtnRow: { display: "flex", gap: 10, marginTop: 10 },
  noteCancelBtn: { flex: 1, padding: "8px 16px", borderRadius: 12, border: "1.5px solid #DDD5C5", background: "#EEE9E0", color: "#00314B", fontWeight: 700, fontSize: 12, cursor: "pointer" },
  noteTap: { fontSize: 13, lineHeight: 1.4, color: "#777", fontStyle: "italic", marginTop: 6, marginBottom: 0, cursor: "pointer" },

  actionBtns: { display: "flex", gap: 8, marginTop: 12 },
  markPaidBtn: { flex: 1, padding: "9px", borderRadius: 12, border: "none", background: "#A6B49E", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  deleteBtn: { flex: 1, padding: "9px", borderRadius: 12, border: "none", background: "#FFF0F0", color: "#E05C6E", fontWeight: 700, fontSize: 13, cursor: "pointer" },

  insightCard: { background: "#fff", borderRadius: 16, margin: "0 16px 12px", overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  insightHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", cursor: "pointer" },
  insightTitle: { fontSize: 14, fontWeight: 700, color: "#00314B" },
  insightBody: { padding: "4px 16px 16px", display: "flex", gap: 12 },
  insightStat: { flex: 1, display: "flex", flexDirection: "column", gap: 2 },
  insightStatLabel: { fontSize: 11, color: "#AAA" },
  insightStatVal: { fontSize: 18, fontWeight: 800, color: "#00314B" },
  insightDivider: { width: 1, background: "#EDE7DC" },

  searchIconBtn: { background: "#EEE9E0", border: "none", borderRadius: 10, padding: "6px 10px", fontSize: 16, cursor: "pointer" },
  searchBar: { padding: "8px 0 4px", position: "relative", display: "flex", alignItems: "center" },
  searchInput: { width: "100%", padding: "10px 36px 10px 14px", borderRadius: 12, border: "1.5px solid #DDD5C5", fontSize: 14, fontFamily: "inherit", outline: "none", background: "#F5F1EB" },
  searchClear: { position: "absolute", right: 10, background: "none", border: "none", color: "#BBB", fontSize: 14, cursor: "pointer" },

  summaryCard: { margin: "0 16px 12px", background: "linear-gradient(135deg, #00314B, #5B3B8C)", borderRadius: 20, padding: "20px 20px", color: "#fff", cursor: "pointer", boxShadow: "0 8px 30px rgba(0,49,75,0.25)" },
  summaryTop: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  summaryMonth: { fontSize: 13, opacity: 0.7, margin: 0 },
  summaryTotal: { fontSize: 28, fontWeight: 800, margin: "4px 0 0", letterSpacing: -1 },
  summaryBreakdown: { marginTop: 16, borderTop: "1px solid rgba(255,255,255,0.15)", paddingTop: 12 },
  summaryRow: { display: "flex", justifyContent: "space-between", marginBottom: 8 },

  timelineCard: { background: "#fff", borderRadius: 16, overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.06)", margin: "0 16px 12px" },
  timelineHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", cursor: "pointer" },
  countBadge: { background: "#A6B49E", color: "#fff", fontSize: 11, fontWeight: 800, padding: "2px 8px", borderRadius: 10 },
  timelineItem: { display: "flex", gap: 12, marginBottom: 4 },
  timelineLine: { display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 4 },
  timelineDot: { width: 10, height: 10, borderRadius: "50%", background: "#A6B49E", flexShrink: 0 },
  timelineConnector: { width: 2, flex: 1, background: "#EDE7DC", minHeight: 20, marginTop: 4 },
  timelineContent: { flex: 1, paddingBottom: 12 },
  timelineAmt: { fontSize: 14, fontWeight: 700, color: "#00314B", margin: 0 },
  timelineMeta: { fontSize: 11, color: "#999", margin: "2px 0 0" },
  timelineNote: { fontSize: 11, color: "#BBB", fontStyle: "italic", margin: "2px 0 0" },
};

// ── STYLES ────────────────────────────────────────────────────────────
const styles = {
  app: { maxWidth: 430, margin: "0 auto", minHeight: "100%", background: "#F5F1EB", position: "relative", fontFamily: "'DM Sans', system-ui, sans-serif", paddingTop: "env(safe-area-inset-top)" },
  screen: { padding: "0 0 20px" },

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
    border: "1.5px solid #EDE7DC",
    borderRadius: 26,
    padding: "12px 12px 12px",
    boxShadow: "0 10px 30px rgba(0,49,75,0.12)",
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
    color: "#00314B",
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
    color: "#00314B",
    flexShrink: 0,
  },

  // Login
  loginWrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(160deg, #EDE4F5 0%, #EBF2F8 50%, #EBF6F4 100%)", padding: 20 },
  loginCard: { background: "#fff", borderRadius: 28, padding: "40px 28px", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.08)", width: "100%", maxWidth: 360 },
  loginLogo: { fontSize: 52, marginBottom: 8 },
  loginTitle: { fontSize: 32, fontWeight: 800, color: "#00314B", margin: "0 0 6px", letterSpacing: -1 },
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
  searchBar: { margin: "-6px 16px 12px", background: "#fff", borderRadius: 14, border: "1px solid #EDE7DC", display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", boxShadow: "0 2px 10px rgba(0,0,0,0.04)" },
  searchIcon: { fontSize: 14, opacity: 0.7 },
  searchInput: { flex: 1, border: "none", outline: "none", fontSize: 13, background: "transparent", color: "#00314B" },
  clearSearch: { width: 28, height: 28, borderRadius: 10, border: "none", cursor: "pointer", background: "#EEE9E0", color: "#888", display: "flex", alignItems: "center", justifyContent: "center" },
  expensesSearchRow: { display: "flex", alignItems: "center", gap: 10, padding: "0 16px 12px" },
  expensesSearchFieldWrap: { flex: 1, position: "relative", display: "flex", alignItems: "center" },
  expensesSearchIconInner: { position: "absolute", left: 12, display: "flex", alignItems: "center", justifyContent: "center" },
  expensesSearchInput: { width: "100%", padding: "10px 36px 10px 34px", borderRadius: 12, border: "1.5px solid #DDD5C5", background: "#fff", fontSize: 15, color: "#00314B", outline: "none" },
  expensesSearchClearBtn: { position: "absolute", right: 10, width: 20, height: 20, borderRadius: 10, border: "none", cursor: "pointer", background: "#CCC", color: "#fff", fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" },
  expensesSearchCancel: { background: "none", border: "none", cursor: "pointer", color: "#A6B49E", fontSize: 14, fontWeight: 700 },
  expensesResultCount: { padding: "0 16px 8px", fontSize: 12, color: "#AAA", fontWeight: 600 },
  searchEmptyWrap: { margin: "6px 16px 14px", background: "#fff", border: "1px solid #EDE7DC", borderRadius: 14, padding: "14px 14px", boxShadow: "0 2px 10px rgba(0,0,0,0.04)", textAlign: "center" },
  searchEmptyTitle: { margin: 0, fontSize: 14, fontWeight: 800, color: "#00314B" },
  searchEmptySub: { margin: "6px 0 0", fontSize: 12, color: "#888" },
  searchEmptyCenter: { textAlign: "center", padding: "60px 20px" },
  searchEmptyEmoji: { fontSize: 48, marginBottom: 12 },
  headerGreet: { fontSize: 22, fontWeight: 800, color: "#00314B", margin: 0 },
  headerSub: { fontSize: 12, color: "#888", margin: "2px 0 0" },
  logoutBtn: { fontSize: 12, color: "#888", background: "rgba(255,255,255,0.7)", border: "none", borderRadius: 20, padding: "6px 14px", cursor: "pointer" },

  // Balance Card
  balanceCard: { margin: "0 16px 20px", background: "linear-gradient(135deg, #00314B, #5B3B8C)", borderRadius: 24, padding: "28px 24px", color: "#fff", boxShadow: "0 12px 40px rgba(0,49,75,0.25)" },
  balanceLabel: { fontSize: 13, opacity: 0.7, margin: "0 0 4px" },
  balanceAmount: { fontSize: 44, fontWeight: 800, margin: "0 0 20px", letterSpacing: -2 },
  balanceRow: { display: "flex", gap: 0 },
  balanceStat: { display: "flex", flexDirection: "column", flex: 1 },
  balanceStatLabel: { fontSize: 11, opacity: 0.6 },
  balanceStatVal: { fontSize: 18, fontWeight: 700 },
  balanceDivider: { width: 1, background: "rgba(255,255,255,0.2)", margin: "0 20px" },
  urgentBanner: { margin: "0 16px 20px", background: "linear-gradient(135deg, #FFF0F0, #FFF5EC)", borderRadius: 16, padding: "16px 18px", border: "1.5px solid #E8A0B0", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", boxShadow: "0 4px 16px rgba(224,92,110,0.12)" },
  urgentBannerTitle: { fontSize: 14, fontWeight: 800, color: "#E05C6E", margin: 0 },
  urgentBannerSub: { fontSize: 11, color: "#C06070", margin: "2px 0 0" },

  // Sections
  section: { padding: "0 16px", marginBottom: 8 },
  sectionHeader: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12, paddingTop: 16 },
  sectionTitle: { fontSize: 14, fontWeight: 700, color: "#00314B" },
  seeAll: { fontSize: 12, color: "#A6B49E", background: "none", border: "none", cursor: "pointer", fontWeight: 600 },
  progressSubTitle: { margin: "6px 0 10px", fontSize: 12, fontWeight: 800, color: "#5B3B8C" },
  planCard: { background: "#fff", borderRadius: 16, padding: "14px 14px", marginBottom: 10, boxShadow: "0 2px 10px rgba(0,0,0,0.04)", border: "1px solid #EDE7DC" },
  planTopRow: { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" },
  planTitle: { margin: 0, fontSize: 13, fontWeight: 800, color: "#00314B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  planRemaining: { margin: 0, fontSize: 13, fontWeight: 800, color: "#5B3B8C", flexShrink: 0 },
  planMetaRow: { display: "flex", justifyContent: "space-between", marginTop: 6 },
  planMetaText: { fontSize: 11, color: "#888", fontWeight: 600 },
  progressTrack: { marginTop: 10, height: 10, background: "#EEE9E0", borderRadius: 999, overflow: "hidden" },
  progressFill: { height: "100%", background: "linear-gradient(135deg, #A6B49E, #4E635E)", borderRadius: 999 },
  oneTimeRow: { background: "#fff", borderRadius: 14, padding: "12px 14px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.04)", border: "1px solid #EDE7DC" },
  oneTimeLabel: { fontSize: 12, fontWeight: 700, color: "#00314B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240 },
  oneTimeAmt: { fontSize: 12, fontWeight: 800, color: "#E05C6E" },

  // Pending
  pendingCard: { background: "#FBF5E0", borderRadius: 14, padding: "14px 16px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #E8C878" },
  pendingAmt: { fontSize: 18, fontWeight: 800, color: "#5A3A10", margin: 0 },
  pendingMeta: { fontSize: 12, color: "#8A6A30", margin: "2px 0 0" },
  confirmBtn: { display: "flex", alignItems: "center", gap: 6, background: "#A6B49E", color: "#fff", border: "none", borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" },

  alertBox: { margin: "0 16px 20px", padding: "12px 16px", borderRadius: 12, border: "1px solid", display: "flex", alignItems: "center", gap: 10 },

  // Action Buttons
  actionRow: { display: "flex", gap: 10, padding: "8px 16px 16px" },
  actionBtn: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "14px", borderRadius: 16, border: "none", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,0.12)" },

  // Expense Row
  expenseRow: { display: "flex", alignItems: "center", gap: 10, background: "#fff", borderRadius: 14, padding: "12px 14px", marginBottom: 8, boxShadow: "0 2px 8px rgba(0,0,0,0.04)" },
  splitDot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  expenseInfo: { flex: 1, minWidth: 0 },
  expenseDesc: { fontSize: 13, fontWeight: 600, color: "#00314B", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  expenseMeta: { fontSize: 11, color: "#999", margin: "2px 0 0" },
  expenseAmts: { textAlign: "right", flexShrink: 0 },
  expenseTotal: { fontSize: 14, fontWeight: 700, color: "#00314B", margin: 0 },
  expenseCam: { fontSize: 11, color: "#E8A0B0", margin: "1px 0 0", fontWeight: 600 },
  deleteBtn: { background: "rgba(192,72,90,0.1)", border: "none", padding: 4, marginTop: 6, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, width: 26, height: 26 },
  splitBadge: { borderRadius: 6, padding: "1px 6px", marginLeft: 4, fontSize: 10 },

  // Sub screens
  subHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "52px 16px 16px" },
  subTitle: { fontSize: 20, fontWeight: 800, color: "#00314B", margin: 0 },
  backBtn: { background: "#fff", border: "none", borderRadius: 12, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.08)" },
  addSmall: { background: "#A6B49E", border: "none", borderRadius: 12, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },

  filterRow: { display: "flex", gap: 8, padding: "0 16px 16px", overflowX: "auto" },
  filterTab: { flexShrink: 0, padding: "6px 16px", borderRadius: 20, border: "1px solid #DDD5C5", background: "#fff", fontSize: 13, color: "#888", cursor: "pointer" },
  filterTabActive: { background: "#00314B", color: "#fff", borderColor: "#00314B", fontWeight: 700 },

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
    border: "1px solid #DDD5C5",
    background: "#fff",
    fontSize: 12,
    color: "#888",
    cursor: "pointer",
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  typeChipActive: {
    background: "#00314B",
    color: "#fff",
    borderColor: "#00314B",
  },
  typeChipActiveCam: {
    background: "#FFF0F0",
    color: "#E05C6E",
    borderColor: "#E8A0B0",
  },


  
  // History
  historyItem: { display: "flex", gap: 12, padding: "12px 16px", borderBottom: "1px solid #EDE7DC", alignItems: "center" },
  historyIcon: { width: 38, height: 38, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 },
  historyInfo: { flex: 1 },
  historyDesc: { fontSize: 13, fontWeight: 600, color: "#00314B", margin: 0 },
  historyMeta: { fontSize: 11, color: "#999", margin: "2px 0 0" },
  historyNote: { fontSize: 11, color: "#AAA", fontStyle: "italic", margin: "2px 0 0" },
  historyAmt: { textAlign: "right" },
  historyAmtText: { fontSize: 14, fontWeight: 700, margin: 0 },
  pendingBadge: { background: "#FBF5E0", color: "#C8A020", borderRadius: 6, padding: "1px 6px", fontSize: 10, marginLeft: 4 },
  confirmedBadge: { background: "#EBF0E8", color: "#2D5A4A", borderRadius: 6, padding: "1px 6px", fontSize: 10, marginLeft: 4 },
  miniConfirm: { fontSize: 11, background: "#A6B49E", color: "#fff", border: "none", borderRadius: 8, padding: "4px 10px", cursor: "pointer", marginTop: 4, fontWeight: 600 },
  markPaidBtn: { marginTop: 10, background: "#00314B", color: "#fff", border: "none", borderRadius: 10, padding: "8px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  markPaidSmall: { marginTop: 6, background: "#00314B", color: "#fff", border: "none", borderRadius: 10, padding: "6px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" },
  menuWrap: { position: "relative", display: "inline-block", marginTop: 6 },
  menuDotBtn: { background: "#EEE9E0", border: "none", borderRadius: 10, fontSize: 18, fontWeight: 800, color: "#888", padding: "4px 10px", cursor: "pointer", letterSpacing: 1, minWidth: 40, minHeight: 36, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" },
  menuDotBtnActive: { background: "#EAE0F8", color: "#5B3B8C" },
  menuPopup: { position: "absolute", right: 0, top: "110%", background: "#fff", borderRadius: 14, boxShadow: "0 8px 30px rgba(0,0,0,0.15)", zIndex: 100, minWidth: 160, overflow: "hidden", border: "1px solid #EDE7DC" },
  menuItem: { display: "block", width: "100%", padding: "14px 18px", textAlign: "left", background: "none", border: "none", borderBottom: "1px solid #EEE9E0", fontSize: 14, fontWeight: 600, color: "#00314B", cursor: "pointer", fontFamily: "'DM Sans', system-ui, sans-serif" },
  menuItemDelete: { borderBottom: "none", color: "#E05C6E" },

  // Modal
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" },
  modal: { background: "#fff", borderRadius: "24px 24px 0 0", padding: "24px 20px 40px", width: "100%", maxWidth: 430, maxHeight: "90vh", overflowY: "auto" },
  dragHandle: { width: 40, height: 4, background: "#E0D8F0", borderRadius: 2, margin: "12px auto 0" },
  sectionLabelRow: { display: "flex", alignItems: "center", gap: 6, margin: "18px 0 10px" },
  sectionLabel: { fontSize: 10, fontWeight: 800, color: "#D5BD96", textTransform: "uppercase", letterSpacing: 1.2 },
  newBadge: { fontSize: 10, fontWeight: 800, background: "#EBF0E8", color: "#2D5A4A", borderRadius: 8, padding: "2px 8px" },
  fieldLabel: { display: "block", fontSize: 11, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 },
  hintText: { fontSize: 11, color: "#BBB", marginTop: 6, marginBottom: 8, paddingLeft: 2 },
  twoCol: { display: "flex", gap: 10 },
  chipRow: { display: "flex", gap: 6, flexWrap: "wrap" },
  freqBtn: { flex: 1, padding: "9px 6px", borderRadius: 12, border: "1.5px solid #DDD5C5", background: "#F5F1EB", fontSize: 12, fontFamily: "inherit", fontWeight: 600, color: "#999", cursor: "pointer" },
  freqBtnActive: { background: "#00314B", borderColor: "#00314B", color: "#fff" },
  dueDateBox: { background: "#FBF8FF", border: "1.5px solid #DDD5C5", borderRadius: 14, padding: "12px 12px 6px", marginBottom: 8 },
  endDateDivider: { height: 1, background: "#DDD5C5", margin: "10px 0" },
  dollarSign: { position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", fontSize: 16, fontWeight: 700, color: "#D5BD96", pointerEvents: "none" },
  previewPill: { padding: "12px 14px", borderRadius: 12, border: "1.5px solid #DDD5C5", background: "#F5F1EB", fontSize: 13, color: "#888" },
  catRow: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  catChip: { padding: "6px 14px", borderRadius: 999, border: "1.5px solid #DDD5C5", background: "#EEE9E0", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  modalTitle: { fontSize: 20, fontWeight: 800, color: "#00314B", margin: 0 },
  closeBtn: { background: "#FDE8EB", border: "none", borderRadius: 10, width: 32, height: 32, padding: 0, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 },

  form: { display: "flex", flexDirection: "column", gap: 8 },
  label: { fontSize: 12, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 8 },
  input: { padding: "12px 14px", borderRadius: 12, border: "1.5px solid #DDD5C5", fontSize: 15, outline: "none", background: "#F5F1EB" },
  splitRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  splitOption: { flex: 1, minWidth: 80, padding: "10px 8px", borderRadius: 12, border: "none", cursor: "pointer", fontSize: 13, transition: "all 0.15s" },
  saveBtn: { marginTop: 16, padding: "16px", borderRadius: 16, border: "none", background: "linear-gradient(135deg, #D5BD96, #7A9BB5)", color: "#fff", fontSize: 16, fontWeight: 800, cursor: "pointer" },
  formNote: { fontSize: 12, color: "#E8A020", background: "#FBF5E0", borderRadius: 10, padding: "8px 12px", margin: "4px 0 0", textAlign: "center" },


  
  // Bottom Nav
  bottomNav: { position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 430, background: "#fff", borderTop: "1px solid #EDE7DC", display: "flex", padding: "8px 0 max(20px, env(safe-area-inset-bottom))", boxShadow: "0 -4px 20px rgba(0,0,0,0.06)", zIndex: 200 },
  navBtn: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, background: "none", border: "none", cursor: "pointer", padding: "6px 0" },
  navBtnActive: {},

  notification: { position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", padding: "12px 24px", borderRadius: 16, fontSize: 14, fontWeight: 700, zIndex: 999, boxShadow: "0 4px 20px rgba(0,0,0,0.15)", whiteSpace: "nowrap" },
};
// ── TARGET DETAILS SCREEN ────────────────────────────────────────────

function TargetDetailsScreen({ user, targetKey, targetSummaries, expenses, payments, onBack, onEditExpense, onLogPaymentForKey }) {
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
            color: "#00314B",
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
              <ExpenseRow
                key={e.id}
                expense={e}
                user={user}
                onEdit={onEditExpense}
                targetSummaries={targetSummaries}
                payments={payments}
                onLogPaymentForKey={onLogPaymentForKey}
              />
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

  {user === "cam" && remaining > 0.005 && typeof onLogPaymentForKey === "function" && (
    <div style={{ marginBottom: 14 }}>
      <QuickPayButtons
        targetKey={targetKey}
        myShare={Number(summary?.suggested ?? remaining)}
        remaining={remaining}
        onLogPaymentForKey={onLogPaymentForKey}
      />
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
        <div style={{ height: 1, background: "#EDE7DC", margin: "6px 0 12px" }} />
      )}

      {confirmedPayments.map((p) => (
        <div key={p.id} style={styles.oneTimeRow}>
          <span style={styles.oneTimeLabel}>
            {formatShortDate(p.date)} · {p.method}
          </span>
          <span style={{ ...styles.oneTimeAmt, color: "#2D5A4A" }}>
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