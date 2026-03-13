import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithCredential, signOut } from "firebase/auth";
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

// ── PAYMENT STREAK ────────────────────────────────────────────────────
function calcPaymentStreak(payments) {
  const confirmed = (payments || []).filter(p => p?.confirmed && p.date);
  if (!confirmed.length) return 0;
  const months = new Set(confirmed.map(p => String(p.date).slice(0, 7)));

  const now = new Date();
  let yr = now.getFullYear();
  let mo = now.getMonth() + 1; // 1-indexed

  let streak = 0;
  for (let i = 0; i < 24; i++) {
    const key = `${yr}-${String(mo).padStart(2, "0")}`;
    if (months.has(key)) {
      streak++;
    } else if (i === 0) {
      // Current month may not have payment yet — skip without breaking streak
    } else {
      break;
    }
    mo--;
    if (mo === 0) { mo = 12; yr--; }
  }
  return streak;
}

// ── BALANCE FORECAST ──────────────────────────────────────────────────
function calcBalanceForecast(balance, payments) {
  if (balance <= 0) return null;
  const confirmed = (payments || []).filter(p => p?.confirmed && p.date);
  if (!confirmed.length) return null;

  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - 3, 1).toISOString().slice(0, 10);
  const recent = confirmed.filter(p => p.date >= cutoff);
  if (!recent.length) return null;

  const totalRecent = recent.reduce((s, p) => s + Number(p.amount || 0), 0);
  const avgMonthly = totalRecent / 3;
  if (avgMonthly <= 0) return null;

  const monthsToGo = Math.ceil(balance / avgMonthly);
  const clearDate = new Date(now.getFullYear(), now.getMonth() + monthsToGo, 1);
  return {
    months: monthsToGo,
    date: clearDate.toLocaleString("en-US", { month: "long", year: "numeric" }),
    avgMonthly,
  };
}

// ── SPARKLINE DATA ────────────────────────────────────────────────────
function getSparklineData(expenses, payments, numMonths = 6) {
  const now = new Date();
  return Array.from({ length: numMonths }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (numMonths - 1 - i), 1);
    const yr = d.getFullYear();
    const mo = d.getMonth() + 1;
    const label = d.toLocaleString("en-US", { month: "short" });
    // Last day of this month for comparison
    const endISO = `${yr}-${String(mo).padStart(2, "0")}-31`;

    const charged = (expenses || [])
      .filter(e => (e.date || "") <= endISO)
      .reduce((s, e) => {
        const amt = Number(e.amount || 0);
        if (e.split === "cam") return s + amt;
        if (e.split === "split") return s + amt / 2;
        return s;
      }, 0);

    const paid = (payments || [])
      .filter(p => p?.confirmed && (p.date || "") <= endISO)
      .reduce((s, p) => s + Number(p.amount || 0), 0);

    return { label, balance: Math.max(0, charged - paid) };
  });
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
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
      <path d={path} stroke={color} fill="none" />
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

// ── PULL TO REFRESH ───────────────────────────────────────────────────
function usePullToRefresh(onRefresh) {
  const [pullY, setPullY] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const active = useRef(false);
  const THRESHOLD = 68;

  useEffect(() => {
    function onTouchStart(e) {
      if (window.scrollY > 4) return;
      startY.current = e.touches[0].clientY;
      active.current = true;
    }
    function onTouchMove(e) {
      if (!active.current) return;
      if (window.scrollY > 4) { active.current = false; return; }
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0) { active.current = false; setPullY(0); return; }
      setPullY(Math.min(dy * 0.42, THRESHOLD + 24));
    }
    function onTouchEnd() {
      if (!active.current) return;
      active.current = false;
      setPullY(prev => {
        if (prev >= THRESHOLD) {
          setRefreshing(true);
          Promise.resolve(onRefresh()).finally(() => {
            setTimeout(() => setRefreshing(false), 700);
          });
        }
        return 0;
      });
    }
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd);
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [onRefresh]);

  return { pullY, refreshing };
}

function PTRIndicator({ pullY, refreshing }) {
  const progress = Math.min(pullY / 68, 1);
  const visible = pullY > 4 || refreshing;
  if (!visible) return null;
  return (
    <div style={{
      position: "fixed", top: "calc(env(safe-area-inset-top, 47px) + 6px)",
      left: "50%", transform: "translateX(-50%)",
      zIndex: 9999, pointerEvents: "none",
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: "50%",
        background: "rgba(255,255,255,0.92)",
        backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
        display: "flex", alignItems: "center", justifyContent: "center",
        transform: `scale(${0.6 + progress * 0.4})`,
        transition: refreshing ? "none" : "transform 0.1s ease",
        opacity: 0.5 + progress * 0.5,
      }}>
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none"
          stroke="#00314B" strokeWidth={2.2} strokeLinecap="round"
          style={{ transform: refreshing ? "none" : `rotate(${progress * 280}deg)`,
            animation: refreshing ? "stSpin 0.7s linear infinite" : "none" }}>
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
      </div>
    </div>
  );
}

function OfflineIndicator() {
  return (
    <motion.div
      initial={{ y: -60 }} animate={{ y: 0 }} exit={{ y: -60 }}
      transition={{ type: "spring", stiffness: 340, damping: 28 }}
      style={{
        position: "fixed", top: 0, left: "50%", transform: "translateX(-50%)",
        width: "100%", maxWidth: 430, zIndex: 9998,
        padding: "calc(env(safe-area-inset-top, 47px) + 6px) 16px 10px",
        background: "rgba(30,30,30,0.92)", backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
      }}
    >
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#E05C6E", flexShrink: 0 }} />
      <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>No internet connection</span>
    </motion.div>
  );
}

function UndoToast({ entries, onUndo }) {
  if (!entries.length) return null;
  const top = entries[entries.length - 1];
  return (
    <motion.div
      key={top.id}
      initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 30 }}
      style={{
        position: "fixed", bottom: "calc(env(safe-area-inset-bottom, 20px) + 76px)",
        left: "50%", transform: "translateX(-50%)",
        width: "calc(100% - 32px)", maxWidth: 398, zIndex: 9997,
        background: "rgba(22,22,28,0.93)", backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderRadius: 16, padding: "12px 14px",
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.9)", flex: 1 }}>{top.label}</span>
      <button
        type="button"
        onClick={() => onUndo(top.id)}
        style={{
          background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 10,
          padding: "6px 14px", fontSize: 13, fontWeight: 800, color: "#fff", cursor: "pointer", flexShrink: 0,
        }}
      >
        Undo
      </button>
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
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [undoQueue, setUndoQueue] = useState([]); // [{ id, label, restore, commitFn, timer }]

  const [paymentDraftKey, setPaymentDraftKey] = useState("general");
  const [paymentDraftAmount, setPaymentDraftAmount] = useState(null);
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setFirebaseUser(u));
    return () => unsub();
  }, []);

  const [listenKey, setListenKey] = useState(0);
  useEffect(() => {
    const unsubExpenses = listenExpenses(setExpenses);
    const unsubPayments = listenPayments(setPayments);
    return () => {
      unsubExpenses();
      unsubPayments();
    };
  }, [listenKey]);

  const handleRefresh = useCallback(() => {
    setListenKey(k => k + 1);
    return new Promise(res => setTimeout(res, 700));
  }, []);

  const { pullY, refreshing } = usePullToRefresh(handleRefresh);

  // Initialize push notifications once we know who the user is
  useEffect(() => {
    if (!realUser) return;

    if (Capacitor.isNativePlatform()) {
      // Native iOS: use APNs via @capacitor/push-notifications
      import("./nativePush").then(({ initNativePush }) => {
        initNativePush(realUser, setScreen);
      });
    } else {
      // Web PWA: use FCM web push via service worker
      initPushNotifications(realUser);

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
    }
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

  // ── Online / offline detection ──────────────────────────────────────
  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Undo helpers ─────────────────────────────────────────────────────
  function pushUndo({ label, restore, commitFn }) {
    const id = Date.now();
    const timer = setTimeout(async () => {
      setUndoQueue(q => q.filter(u => u.id !== id));
      try { await commitFn(); } catch (err) { console.error("Undo commit failed:", err); }
    }, 4000);
    setUndoQueue(q => [...q, { id, label, restore, timer }]);
  }

  function triggerUndo(id) {
    setUndoQueue(q => {
      const entry = q.find(u => u.id === id);
      if (entry) { clearTimeout(entry.timer); entry.restore(); }
      return q.filter(u => u.id !== id);
    });
  }

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


  async function handleDeletePendingPayment(id) {
    if (realUser !== "emma") return;
    const payment = payments.find((p) => p.id === id);
    if (!payment || payment.confirmed) return;
    setPayments((prev) => prev.filter((p) => p.id !== id));
    pushUndo({
      label: `Removed $${Number(payment.amount || 0).toFixed(2)} payment`,
      restore: () => setPayments((prev) => [payment, ...prev.filter(p => p.id !== id)]),
      commitFn: async () => {
        try { await deletePaymentInDb(id); }
        catch (err) {
          console.error("Failed to delete pending payment:", err);
          setPayments((prev) => [payment, ...prev.filter(p => p.id !== id)]);
          notify("Couldn't remove payment.", "error");
        }
      },
    });
  }

  async function handleDeleteConfirmedPayment(id) {
    if (user !== "emma") return;

    const payment = payments.find((p) => p.id === id);
    if (!payment || !payment.confirmed) return;

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

    pushUndo({
      label: `Deleted $${Number(removed.amount || 0).toFixed(2)} payment`,
      restore: () => {
        setPayments((prev) => [removed, ...prev.filter(p => p.id !== id)]);
        if (revertExpense) setExpenses((prev) => prev.map((e) => e.id === revertExpense.id ? revertExpense : e));
      },
      commitFn: async () => {
        try {
          await deletePaymentInDb(id);
          if (revertExpense) await updateExpenseInDb(revertExpense.id, { status: "unpaid", paidAt: null });
        } catch (err) {
          console.error("Failed to delete payment:", err);
          setPayments((prev) => [removed, ...prev.filter(p => p.id !== id)]);
          if (revertExpense) setExpenses((prev) => prev.map((e) => e.id === revertExpense.id ? revertExpense : e));
          notify("Couldn't delete payment.", "error");
        }
      },
    });
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
    const removed = expenses.find((e) => e.id === id) || null;
    if (!removed) return;
    setExpenses((prev) => prev.filter((e) => e.id !== id));
    pushUndo({
      label: `Deleted "${removed.description}"`,
      restore: () => setExpenses((prev) => [removed, ...prev.filter(e => e.id !== id)]),
      commitFn: async () => {
        try { await deleteExpenseInDb(id); }
        catch (err) {
          console.error("Failed to delete expense:", err);
          setExpenses((prev) => [removed, ...prev.filter(e => e.id !== id)]);
          notify("Couldn't delete expense.", "error");
        }
      },
    });
  }

  async function handleEditExpense(id, updates) {
    try {
      const original = expenses.find((e) => e.id === id);
      const enriched = { ...updates, updatedAt: new Date().toISOString().slice(0, 10) };
      if (
        original &&
        updates.amount !== undefined &&
        Math.abs(Number(updates.amount) - Number(original.amount)) > 0.005
      ) {
        enriched.previousAmount = Number(original.amount);
      }
      await updateExpenseInDb(id, enriched);
      setEditingExpense(null);
      notify("Expense updated!");
    } catch (err) {
      console.error("Failed to update expense:", err);
      notify("Couldn't update expense.", "error");
    }
  }

  if (!firebaseUser) return <LoginScreen />;

  return (
    <div style={{ ...styles.app, paddingTop: (realUser === "emma" && viewAs === "cam") ? "calc(env(safe-area-inset-top, 47px) + 36px)" : 0 }}>
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
        .lg-nav-pill{position:absolute;border-radius:14px;pointer-events:none;transition:left .42s cubic-bezier(.34,1.56,.64,1),width .42s cubic-bezier(.34,1.56,.64,1),top .42s cubic-bezier(.34,1.56,.64,1),height .42s cubic-bezier(.34,1.56,.64,1);backdrop-filter:blur(24px) saturate(200%);-webkit-backdrop-filter:blur(24px) saturate(200%);background:linear-gradient(145deg,rgba(255,255,255,0.16),rgba(255,255,255,0.07));border:1px solid rgba(255,255,255,0.22);box-shadow:0 2px 16px rgba(0,0,0,0.28),inset 0 1px 0 rgba(255,255,255,0.28);overflow:hidden}
        .lg-nav-pill::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.18),transparent);background-size:200% 100%;animation:lgShimmer .6s ease forwards .05s}
      `}</style>
      <PTRIndicator pullY={pullY} refreshing={refreshing} />
      <AnimatePresence>{!isOnline && <OfflineIndicator />}</AnimatePresence>
      <AnimatePresence><UndoToast entries={undoQueue} onUndo={triggerUndo} /></AnimatePresence>
      <AnimatePresence>
        {updateAvailable && <UpdateBanner onTap={() => window.location.reload()} />}
      </AnimatePresence>
      {/* Cameron view banner — shown when Emma is previewing as Cam */}
      {realUser === "emma" && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999,
          background: viewAs === "cam" ? "#00314B" : "transparent",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: viewAs === "cam" ? "calc(env(safe-area-inset-top, 47px) + 4px) 16px 8px" : "0",
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
          onDeletePendingPayment={handleDeletePendingPayment}
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
    allExpenses={expenses}
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
    const isNative = Capacitor.isNativePlatform();
    setErrMsg(`platform: ${isNative ? "native" : "web"}`);
    try {
      if (isNative) {
        const { FirebaseAuthentication } = await import("@capacitor-firebase/authentication");
        const result = await FirebaseAuthentication.signInWithGoogle({ skipNativeAuth: true });
        const idToken = result.credential?.idToken;
        const accessToken = result.credential?.accessToken;
        if (!idToken) throw new Error(`No idToken. Result: ${JSON.stringify(result)}`);
        setErrMsg(`got idToken, signing in...`);
        const credential = GoogleAuthProvider.credential(idToken, accessToken);
        const userCred = await signInWithCredential(auth, credential);
        setErrMsg(`signed in as ${userCred?.user?.email}`);
      } else {
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
    <div style={{
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: "#0D2818",
      display: "flex",
      flexDirection: "column",
      padding: "calc(env(safe-area-inset-top, 47px) + 44px) 32px calc(env(safe-area-inset-bottom, 20px) + 44px)",
      overflow: "hidden",
      fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      {/* Decorative blobs */}
      <div style={{ position: "absolute", top: -120, right: -120, width: 340, height: 340, borderRadius: "50%", background: "rgba(166,180,158,0.07)", pointerEvents: "none" }} />
      <div style={{ position: "absolute", bottom: 180, left: -100, width: 260, height: 260, borderRadius: "50%", background: "rgba(166,180,158,0.05)", pointerEvents: "none" }} />
      <div style={{ position: "absolute", top: "38%", right: -60, width: 160, height: 160, borderRadius: "50%", background: "rgba(166,180,158,0.04)", pointerEvents: "none" }} />

      {/* Top icon */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ width: 52, height: 52, borderRadius: 18, background: "rgba(166,180,158,0.18)", border: "1px solid rgba(166,180,158,0.25)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 26 }}>💸</span>
        </div>
      </div>

      {/* Big headline */}
      <div style={{ flex: 1 }}>
        <h1 style={{ fontSize: 68, fontWeight: 900, color: "#F5F1EB", margin: 0, lineHeight: 0.95, letterSpacing: -3, textTransform: "uppercase" }}>
          SPLIT<br />TRACK
        </h1>
        <p style={{ color: "rgba(166,180,158,0.75)", fontSize: 15, marginTop: 20, lineHeight: 1.6, maxWidth: 260 }}>
          Track shared expenses with your partner — simply and beautifully.
        </p>

        {/* Decorative pill tags */}
        <div style={{ display: "flex", gap: 8, marginTop: 28, flexWrap: "wrap" }}>
          {["Bills", "Payments", "Balance"].map(tag => (
            <span key={tag} style={{ padding: "6px 14px", borderRadius: 999, border: "1px solid rgba(166,180,158,0.22)", color: "rgba(166,180,158,0.6)", fontSize: 12, fontWeight: 600 }}>
              {tag}
            </span>
          ))}
        </div>
      </div>

      {/* Bottom CTA */}
      <div>
        {errMsg && (
          <p style={{ color: "#F8C4CD", fontSize: 12, marginBottom: 14, wordBreak: "break-word", lineHeight: 1.5 }}>{errMsg}</p>
        )}
        <button
          style={{
            width: "100%",
            padding: "18px 0",
            borderRadius: 18,
            border: "none",
            background: "#F5F1EB",
            color: "#0D2818",
            fontSize: 16,
            fontWeight: 800,
            cursor: "pointer",
            opacity: loading ? 0.7 : 1,
            letterSpacing: 0.2,
            boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
          }}
          onClick={handleGoogleSignIn}
          disabled={loading}
        >
          {loading ? "Signing in…" : "Get Started"}
        </button>
        <p style={{ textAlign: "center", color: "rgba(255,255,255,0.28)", fontSize: 12, marginTop: 16, lineHeight: 1.5 }}>
          Sign in with Google · Access based on your email
        </p>
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

function DashboardPendingCard({ pendingPayments = [], onConfirm, onResolveDispute, onRejectPayment, onDeletePendingPayment, user, targetSummaries, expenses = [] }) {
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
                          {user === "emma" && onDeletePendingPayment && (
                            <button
                              type="button"
                              style={{ background: "#FFF0F0", color: "#E05C6E", border: "1.5px solid #F8C4CD", borderRadius: 9, padding: "9px 12px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}
                              onClick={() => { onDeletePendingPayment(p.id); setExpandedPayment(null); }}
                            >
                              Remove
                            </button>
                          )}
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

// ── SPARKLINE CHART ───────────────────────────────────────────────────
function SparklineChart({ data, width = 200, height = 48 }) {
  if (!data || data.length < 2) return null;
  const values = data.map(d => d.balance);
  const maxVal = Math.max(...values, 1);
  const PAD = 4;
  const pts = values.map((v, i) => [
    PAD + (i / (values.length - 1)) * (width - 2 * PAD),
    height - PAD - (v / maxVal) * (height - 2 * PAD),
  ]);
  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.25)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#sparkGrad)" />
      <path d={linePath} fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={3.5} fill="#fff" />
    </svg>
  );
}

// ── INSIGHTS STRIP ────────────────────────────────────────────────────
function InsightsStrip({ payments = [], expenses = [], balance = 0 }) {
  const streak = calcPaymentStreak(payments);
  const forecast = calcBalanceForecast(balance, payments);
  const sparkData = getSparklineData(expenses, payments, 6);

  if (streak === 0 && !forecast) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay: 0.08, ease: "easeOut" }}
      style={{ margin: "12px 16px 0", display: "flex", gap: 10 }}
    >
      {/* Streak card */}
      {streak > 0 && (
        <div style={{
          flex: 1, borderRadius: 22, overflow: "hidden",
          background: "linear-gradient(150deg, #0B3D5C 0%, #164E6B 100%)",
          boxShadow: "0 10px 30px rgba(0,49,75,0.28), inset 0 1px 0 rgba(255,255,255,0.12)",
          border: "1px solid rgba(255,255,255,0.1)",
          padding: "16px 14px 14px",
          display: "flex", flexDirection: "column", gap: 6,
          minWidth: 0,
        }}>
          <span style={{ fontSize: 24 }}>🔥</span>
          <div style={{ marginTop: 2 }}>
            <span style={{ fontSize: 32, fontWeight: 900, color: "#fff", letterSpacing: -1.5 }}>{streak}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.5)", marginLeft: 4 }}>
              {streak === 1 ? "month" : "months"}
            </span>
          </div>
          <span style={{ fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.45)", textTransform: "uppercase", letterSpacing: 0.8 }}>
            {streak >= 4 ? "On fire 🔥" : streak >= 2 ? "Keep it up" : "Good start!"}
          </span>
        </div>
      )}

      {/* Forecast + sparkline card */}
      {forecast && (
        <div style={{
          flex: streak > 0 ? 1.65 : 1, borderRadius: 22, overflow: "hidden",
          background: "linear-gradient(150deg, #1E4A3C 0%, #2D6050 100%)",
          boxShadow: "0 10px 30px rgba(45,90,74,0.3), inset 0 1px 0 rgba(255,255,255,0.1)",
          border: "1px solid rgba(255,255,255,0.1)",
          padding: "16px 14px 14px",
          display: "flex", flexDirection: "column", gap: 3,
          minWidth: 0, position: "relative",
        }}>
          <span style={{ fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.5)", letterSpacing: 1, textTransform: "uppercase" }}>
            Balance clears
          </span>
          <div style={{ marginTop: 2 }}>
            <span style={{ fontSize: 17, fontWeight: 900, color: "#B8F5D0", letterSpacing: -0.4, lineHeight: 1.2 }}>{forecast.date}</span>
          </div>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontWeight: 700, marginTop: 2 }}>
            avg ${forecast.avgMonthly.toFixed(0)}/mo · {forecast.months} mo{forecast.months !== 1 ? "s" : ""} to go
          </span>
          {/* Sparkline overlay */}
          <div style={{ position: "absolute", bottom: 12, right: 12, opacity: 0.6 }}>
            <SparklineChart data={sparkData} width={88} height={34} />
          </div>
        </div>
      )}
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
            style={{ background: "#E0D8CC", border: "none", borderRadius: 10, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
            <Icon path={icons.x} size={18} color="#6B5B8E" />
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
const PRESET_AMOUNTS = [20, 50, 100];

function CamQuickPayModal({ expenses = [], targetSummaries, onSubmit, onClose }) {
  const [step, setStep] = useState("amount"); // "amount" | "target" | "confirm"
  const [selectedAmt, setSelectedAmt] = useState(null); // 20 | 50 | 100 | "custom"
  const [customVal, setCustomVal] = useState("");
  const [targetMode, setTargetMode] = useState(null); // "overdue" | "specific"
  const [selectedExpIds, setSelectedExpIds] = useState(new Set());
  const [method, setMethod] = useState("Zelle");
  const methodTabRefs = useRef([]);
  const [methodPill, setMethodPill] = useState({ left: 0, width: 0 });
  const methodContainerRef = useRef(null);

  useEffect(() => {
    const measure = () => {
      const idx = PAYMENT_METHODS.indexOf(method);
      const el = methodTabRefs.current[idx];
      const container = methodContainerRef.current;
      if (el && container) {
        const elRect = el.getBoundingClientRect();
        const conRect = container.getBoundingClientRect();
        setMethodPill({ left: elRect.left - conRect.left + container.scrollLeft, width: elRect.width });
      }
    };
    measure();
    // Retry after paint in case layout isn't ready yet
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [method, step]);

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

  const [proofOpen, setProofOpen] = useState(false);
  const [proofFile, setProofFile] = useState(null);
  const [proofPreview, setProofPreview] = useState(null);
  const [uploading, setUploading] = useState(false);
  const proofInputRef = useRef(null);

  function handleProofPick(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setProofFile(file);
    const reader = new FileReader();
    reader.onload = ev => setProofPreview(ev.target.result);
    reader.readAsDataURL(file);
  }

  async function handleConfirm() {
    let proofUrl;
    if (proofFile) {
      setUploading(true);
      try { proofUrl = await uploadProof(proofFile); } catch (err) { console.error("Proof upload failed:", err); }
      setUploading(false);
    }
    const today = new Date().toISOString().slice(0, 10);
    if (targetMode === "overdue") {
      overduePlan.forEach(({ e, pay, tKey }) => {
        onSubmit({ amount: pay, date: today, method, appliedToKey: tKey, note: `Quick pay — clears overdue: ${e.description}`, ...(proofUrl ? { proofUrl } : {}) });
      });
    } else if (targetMode === "specific" && selectedExps.length > 0) {
      selectedExps.forEach(e => {
        const isRec = e.recurring && e.recurring !== "none";
        const tKey = isRec ? `grp:${e.groupId || e.id}` : `exp:${e.id}`;
        onSubmit({ amount: camShare(e), date: today, method, appliedToKey: tKey, ...(proofUrl ? { proofUrl } : {}) });
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
            style={{ background: "#E0D8CC", border: "none", borderRadius: 10, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <Icon path={icons.x} size={18} color="#6B5B8E" />
          </button>
        </div>

        {/* ── STEP 1: Amount ── */}
        {step === "amount" && (
          <div style={{ padding: "0 20px 28px" }}>

            {/* Preset amount cards — 3 across */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 12 }}>
              {PRESET_AMOUNTS.map(amt => {
                const sel = selectedAmt === amt;
                return (
                  <motion.button key={amt} type="button"
                    whileTap={{ scale: 0.94 }}
                    onClick={() => { setSelectedAmt(amt); setCustomVal(""); }}
                    style={{
                      padding: "22px 0", borderRadius: 18, border: "none",
                      background: sel ? "linear-gradient(145deg, #00314B, #1B5C80)" : "#F5F1EB",
                      color: sel ? "#fff" : "#00314B",
                      fontSize: 26, fontWeight: 900, cursor: "pointer",
                      boxShadow: sel ? "0 6px 18px rgba(0,49,75,0.28)" : "0 2px 6px rgba(0,0,0,0.06)",
                      transition: "background 0.18s, box-shadow 0.18s, color 0.18s",
                      fontFamily: "inherit",
                    }}>
                    ${amt}
                  </motion.button>
                );
              })}
            </div>

            {/* Custom amount card */}
            <motion.button type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => setSelectedAmt("custom")}
              style={{
                width: "100%", padding: "16px", borderRadius: 18, border: "none",
                background: selectedAmt === "custom" ? "#EEE9E0" : "#F5F1EB",
                color: selectedAmt === "custom" ? "#00314B" : "#AAA",
                fontSize: 15, fontWeight: 800, cursor: "pointer",
                boxShadow: "0 2px 6px rgba(0,0,0,0.05)",
                marginBottom: 24, fontFamily: "inherit", transition: "background 0.18s, color 0.18s",
              }}>
              {selectedAmt === "custom" ? "Custom amount" : "Enter custom amount"}
            </motion.button>

            {/* Custom amount input */}
            {selectedAmt === "custom" && (
              <div style={{ position: "relative", display: "flex", alignItems: "center", marginBottom: 24, marginTop: -16 }}>
                <span style={{ position: "absolute", left: 16, fontSize: 22, fontWeight: 900, color: "#00314B", pointerEvents: "none" }}>$</span>
                <input
                  autoFocus type="number" min="0.01" step="0.01" placeholder="0.00"
                  value={customVal}
                  onChange={e => setCustomVal(e.target.value)}
                  style={{ width: "100%", padding: "16px 16px 16px 36px", borderRadius: 14, border: "2px solid #D5BD96", fontSize: 22, fontWeight: 900, color: "#00314B", outline: "none", boxSizing: "border-box", background: "#F5F1EB" }}
                />
              </div>
            )}

            {/* Payment method — swipeable sliding pill row */}
            <p style={{ fontSize: 11, fontWeight: 700, color: "#BBB", textTransform: "uppercase", letterSpacing: 1, margin: "0 0 10px" }}>Pay via</p>
            <div ref={methodContainerRef}
              style={{ position: "relative", display: "flex", gap: 0, overflowX: "auto", scrollbarWidth: "none", borderRadius: 14, background: "#F0ECE5", padding: 4, marginBottom: 24 }}>
              {/* sliding pill */}
              <div style={{
                position: "absolute", top: 4, height: "calc(100% - 8px)",
                left: methodPill.left, width: methodPill.width,
                borderRadius: 10, background: "#00314B",
                transition: "left 0.25s cubic-bezier(0.34,1.56,0.64,1), width 0.2s ease",
                pointerEvents: "none", zIndex: 0,
              }} />
              {PAYMENT_METHODS.map((m, i) => (
                <button key={m} type="button"
                  ref={el => methodTabRefs.current[i] = el}
                  onClick={() => setMethod(m)}
                  style={{
                    position: "relative", zIndex: 1, flexShrink: 0,
                    padding: "9px 14px", borderRadius: 10, border: "none",
                    background: "transparent",
                    color: method === m ? "#fff" : "#888",
                    fontSize: 13, fontWeight: 700, cursor: "pointer",
                    transition: "color 0.2s", whiteSpace: "nowrap", fontFamily: "inherit",
                  }}>
                  {m}
                </button>
              ))}
            </div>

            <motion.button type="button"
              whileTap={{ scale: 0.97 }}
              disabled={!canProceedAmount}
              onClick={() => setStep("target")}
              style={{
                width: "100%", padding: "17px", borderRadius: 18, border: "none",
                background: canProceedAmount ? "linear-gradient(135deg, #00314B, #1B4D6B)" : "#E8E3DC",
                color: canProceedAmount ? "#fff" : "#BBB",
                fontSize: 16, fontWeight: 800, cursor: canProceedAmount ? "pointer" : "default",
                fontFamily: "inherit", boxShadow: canProceedAmount ? "0 6px 18px rgba(0,49,75,0.22)" : "none",
                transition: "background 0.2s, box-shadow 0.2s",
              }}>
              Next →
            </motion.button>
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

            {/* Proof toggle */}
            <button type="button" onClick={() => setProofOpen(o => !o)}
              style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: proofOpen ? "#EAF0EE" : "#F5F1EB", border: "none", borderRadius: 14, padding: "12px 14px", cursor: "pointer", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 10, background: proofOpen ? "#4E635E" : "#DDD5C5", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/>
                  </svg>
                </div>
                <div style={{ textAlign: "left" }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#00314B" }}>Add payment proof</p>
                  <p style={{ margin: 0, fontSize: 11, color: "#AAA" }}>Optional — screenshot or photo</p>
                </div>
              </div>
              <div style={{ width: 44, height: 26, borderRadius: 13, background: proofOpen ? "#4E635E" : "#DDD5C5", position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
                <div style={{ position: "absolute", top: 3, left: proofOpen ? 21 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.2)", transition: "left 0.2s cubic-bezier(.34,1.56,.64,1)" }} />
              </div>
            </button>

            <AnimatePresence>
              {proofOpen && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }} style={{ overflow: "hidden", marginBottom: 12 }}>
                  <input ref={proofInputRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={handleProofPick} />
                  {proofPreview ? (
                    <div style={{ position: "relative" }}>
                      <img src={proofPreview} alt="proof" style={{ width: "100%", borderRadius: 14, maxHeight: 200, objectFit: "cover", display: "block" }} />
                      <button type="button" onClick={() => { setProofFile(null); setProofPreview(null); }}
                        style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,0.55)", border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, padding: "4px 10px", cursor: "pointer" }}>
                        Remove
                      </button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => proofInputRef.current?.click()}
                      style={{ width: "100%", padding: "20px", borderRadius: 14, border: "2px dashed #C5D5C0", background: "#F5F9F5", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, cursor: "pointer" }}>
                      <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="#A6B49E" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
                      </svg>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#4E635E" }}>Tap to choose photo</span>
                      <span style={{ fontSize: 11, color: "#AAA" }}>Screenshot, Zelle receipt, etc.</span>
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            <button type="button" onClick={handleConfirm} disabled={uploading}
              style={{ width: "100%", padding: "16px", borderRadius: 16, border: "none", background: uploading ? "#C5D5C0" : "linear-gradient(135deg, #A6B49E, #4E635E)", color: "#fff", fontSize: 16, fontWeight: 800, cursor: uploading ? "default" : "pointer" }}>
              {uploading ? "Uploading…" : "Confirm Payment ✓"}
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

  function daysAgo(dateStr) {
    if (!dateStr) return 9999;
    return Math.ceil((today - new Date(dateStr + "T12:00:00")) / 86400000);
  }

  // 1. Overdue/Upcoming: Cameron's unpaid charges due within 21 days
  const upcoming = (expenses || [])
    .filter((e) => {
      if (e.status === "paid") return false;
      if (!(e.split === "cam" || e.split === "split")) return false;
      const due = e.nextDue || e.dueDate;
      if (!due) return false;
      const diffDays = Math.ceil((new Date(due + "T12:00:00") - today) / 86400000);
      return diffDays <= 21;
    })
    .sort((a, b) => {
      const aOvr = getUrgencyLevel(a) === "overdue";
      const bOvr = getUrgencyLevel(b) === "overdue";
      if (a.mandatory && aOvr && !(b.mandatory && bOvr)) return -1;
      if (b.mandatory && bOvr && !(a.mandatory && aOvr)) return 1;
      if (a.mandatory && !b.mandatory) return -1;
      if (b.mandatory && !a.mandatory) return 1;
      return new Date(a.nextDue || a.dueDate) - new Date(b.nextDue || b.dueDate);
    });

  // 2. Pending: payments awaiting confirmation
  const pending = (payments || []).filter((p) => !p.confirmed && !p.rejected && p.type !== "dispute");

  // 3. Returned payments (Emma rejected/returned to Cameron)
  const returned = (payments || [])
    .filter((p) => p.rejected === true)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  // 4. Recently confirmed payments (last 30 days)
  const recentlyConfirmed = (payments || [])
    .filter((p) => p.confirmed && p.type !== "dispute" && daysAgo(p.date) <= 30)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  // 5. Recent new charges — use createdAt if available, fall back to date
  function expCreatedDaysAgo(e) {
    if (e.createdAt) {
      const ts = e.createdAt.toDate ? e.createdAt.toDate() : new Date(e.createdAt);
      return Math.ceil((today - ts) / 86400000);
    }
    return daysAgo(e.date);
  }
  const recentCharges = (expenses || [])
    .filter((e) => {
      if (!(e.split === "cam" || e.split === "split")) return false;
      return expCreatedDaysAgo(e) <= 21;
    })
    .sort((a, b) => {
      const ta = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.date);
      const tb = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.date);
      return tb - ta;
    });

  // 6. Edited amounts (last 30 days, only if previousAmount recorded)
  const editedExpenses = (expenses || [])
    .filter((e) => {
      if (!(e.split === "cam" || e.split === "split")) return false;
      if (!e.updatedAt || e.previousAmount === undefined) return false;
      return daysAgo(e.updatedAt) <= 30;
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  // 7. All resolved disputes (accepted OR declined, last 30 days)
  const resolvedDisputes = (payments || [])
    .filter((p) => p.type === "dispute" && p.confirmed && p.disputeStatus && daysAgo(p.date) <= 30)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  // ── Smart card data ────────────────────────────────────────────────
  // Current balance (what Cameron owes)
  const camBalance = (expenses || [])
    .filter((e) => e.status !== "paid" && (e.split === "cam" || e.split === "split"))
    .reduce((s, e) => s + (e.split === "cam" ? Number(e.amount || 0) : Number(e.amount || 0) / 2), 0)
    - (payments || []).filter((p) => p.confirmed).reduce((s, p) => s + Number(p.amount || 0), 0);

  // Last confirmed payment
  const lastPayment = (payments || [])
    .filter((p) => p.confirmed && p.type !== "dispute")
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null;

  // Payment streak
  const streak = calcPaymentStreak(payments);

  // This month's total due
  const nowDate = new Date();
  const monthKey = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, "0")}`;
  const monthDue = (expenses || [])
    .filter((e) => {
      if (e.status === "paid") return false;
      if (!(e.split === "cam" || e.split === "split")) return false;
      const iso = e.nextDue || e.dueDate || e.date;
      return String(iso || "").startsWith(monthKey);
    })
    .reduce((s, e) => s + (e.split === "cam" ? Number(e.amount || 0) : Number(e.amount || 0) / 2), 0);

  // Has Cameron paid anything this month?
  const paidThisMonth = (payments || [])
    .filter((p) => !p.confirmed && String(p.date || "").startsWith(monthKey)).length > 0
    || (payments || []).filter((p) => p.confirmed && String(p.date || "").startsWith(monthKey)).length > 0;

  const hasAny = upcoming.length > 0 || pending.length > 0 || returned.length > 0 ||
    recentlyConfirmed.length > 0 || recentCharges.length > 0 ||
    editedExpenses.length > 0 || resolvedDisputes.length > 0;

  function camAmt(e) {
    const amt = Number(e.amount || 0);
    return e.split === "cam" ? amt : amt / 2;
  }

  function dueLabel(e) {
    const due = e.nextDue || e.dueDate;
    if (!due) return "";
    const dueD = new Date(due + "T12:00:00");
    dueD.setHours(0, 0, 0, 0);
    const diff = Math.ceil((dueD - today) / 86400000);
    if (getUrgencyLevel(e) === "overdue") return "Overdue";
    if (diff === 0) return "Due today";
    if (diff === 1) return "Due tomorrow";
    return `Due in ${diff}d`;
  }

  function SectionLabel({ children }) {
    return (
      <p style={{ fontSize: 11, fontWeight: 800, color: "#A6B7CB", textTransform: "uppercase", letterSpacing: 1, margin: "16px 0 8px 2px" }}>
        {children}
      </p>
    );
  }

  function NotifCard({ bg, border, left, title, sub, right, note, onClick }) {
    return (
      <div
        onClick={onClick}
        style={{ background: bg, borderRadius: 16, padding: "13px 14px", marginBottom: 8, border: `1.5px solid ${border}`, cursor: onClick ? "pointer" : "default", display: "flex", alignItems: "center", gap: 12 }}
      >
        {left && (
          <div style={{ width: 36, height: 36, borderRadius: 12, background: "rgba(0,0,0,0.06)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {left}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "#0A1E2B", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</p>
          <p style={{ margin: "2px 0 0", fontSize: 11, fontWeight: 600, color: "#888", lineHeight: 1.4 }}>{sub}</p>
          {note && <p style={{ margin: "5px 0 0", fontSize: 11, color: "#999", fontStyle: "italic", lineHeight: 1.4 }}>"{note}"</p>}
        </div>
        {right && <span style={{ fontSize: 15, fontWeight: 900, flexShrink: 0, marginLeft: 4 }}>{right}</span>}
      </div>
    );
  }

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 800 }} />
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 340, damping: 32 }}
        style={{
          position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
          width: "100%", maxWidth: 430,
          background: "linear-gradient(170deg, #EAF0F6 0%, #F5F1EB 100%)",
          borderRadius: "26px 26px 0 0",
          zIndex: 801,
          paddingBottom: "max(28px, env(safe-area-inset-bottom))",
          maxHeight: "82vh", overflowY: "auto",
          boxShadow: "0 -8px 40px rgba(0,0,0,0.18)",
        }}
      >
        {/* Handle */}
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 10, paddingBottom: 0 }}>
          <div style={{ width: 38, height: 4, borderRadius: 2, background: "#D5C9BC" }} />
        </div>

        {/* ── Hero header with large bell ── */}
        <div style={{ position: "relative", padding: "16px 18px 0", overflow: "hidden" }}>
          {/* Big decorative bell — background */}
          <div style={{ position: "absolute", right: -8, top: -14, opacity: 0.06, pointerEvents: "none" }}>
            <svg width={130} height={130} viewBox="0 0 24 24" fill="#00314B">
              <path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
            </svg>
          </div>

          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {/* Bell icon circle */}
              <div style={{
                width: 52, height: 52, borderRadius: 18, flexShrink: 0,
                background: "linear-gradient(145deg, #002B42 0%, #1B5C80 100%)",
                boxShadow: "0 8px 24px rgba(0,49,75,0.3), inset 0 1px 0 rgba(255,255,255,0.15)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Icon path={icons.bell} size={24} color="#fff" />
              </div>
              <div>
                <p style={{ margin: 0, fontSize: 20, fontWeight: 900, color: "#0A1E2B", letterSpacing: -0.6 }}>Notifications</p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#A6B7CB", fontWeight: 600 }}>
                  {hasAny
                    ? [
                        upcoming.length > 0 && `${upcoming.length} due`,
                        pending.length > 0 && `${pending.length} pending`,
                        returned.length > 0 && `${returned.length} returned`,
                      ].filter(Boolean).join(" · ") || "Recent activity"
                    : "You're all caught up"}
                </p>
              </div>
            </div>
            <button onClick={onClose} type="button"
              style={{ background: "#EEE9E3", border: "none", borderRadius: "50%", width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, marginTop: 2, padding: 0, lineHeight: 0 }}>
              <Icon path={icons.x} size={18} color="#3A3A3A" />
            </button>
          </div>

          {/* ── Smart summary card ── */}
          <div style={{
            marginTop: 14, borderRadius: 20, overflow: "hidden",
            background: "linear-gradient(145deg, #002B42 0%, #1A5470 100%)",
            boxShadow: "0 8px 24px rgba(0,49,75,0.28), inset 0 1px 0 rgba(255,255,255,0.1)",
            padding: "14px 16px 16px",
          }}>
            {/* Balance row */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 10 }}>
              <div>
                <p style={{ margin: 0, fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 1 }}>Current Balance</p>
                <p style={{ margin: "3px 0 0", fontSize: 28, fontWeight: 900, color: "#fff", letterSpacing: -1 }}>
                  ${Math.max(0, camBalance).toFixed(2)}
                </p>
              </div>
              {streak > 0 && (
                <div style={{ textAlign: "right" }}>
                  <p style={{ margin: 0, fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 1 }}>Streak</p>
                  <p style={{ margin: "3px 0 0", fontSize: 20, fontWeight: 900, color: "#FFD66B", letterSpacing: -0.5 }}>
                    🔥 {streak}mo
                  </p>
                </div>
              )}
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: "rgba(255,255,255,0.1)", marginBottom: 10 }} />

            {/* Stats row */}
            <div style={{ display: "flex", gap: 0 }}>
              <div style={{ flex: 1, textAlign: "center" }}>
                <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.45)", textTransform: "uppercase", letterSpacing: 0.7 }}>Due this month</p>
                <p style={{ margin: "3px 0 0", fontSize: 15, fontWeight: 900, color: monthDue > 0 ? "#FFB4BD" : "#B8F5D0" }}>
                  {monthDue > 0 ? `$${monthDue.toFixed(2)}` : "All clear"}
                </p>
              </div>
              <div style={{ width: 1, background: "rgba(255,255,255,0.1)" }} />
              <div style={{ flex: 1, textAlign: "center" }}>
                <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.45)", textTransform: "uppercase", letterSpacing: 0.7 }}>Last payment</p>
                <p style={{ margin: "3px 0 0", fontSize: 15, fontWeight: 900, color: "rgba(255,255,255,0.85)" }}>
                  {lastPayment ? formatShortDate(lastPayment.date) : "None yet"}
                </p>
              </div>
            </div>
          </div>

          {/* ── Smart nudge cards ── */}
          <div style={{ display: "flex", gap: 10, marginTop: 10, marginBottom: 2 }}>
            {/* No payment this month nudge */}
            {!paidThisMonth && monthDue > 0 && (
              <div style={{
                flex: 1, borderRadius: 16, padding: "12px 14px",
                background: "linear-gradient(135deg, #3D1A1A 0%, #5C2020 100%)",
                boxShadow: "0 4px 14px rgba(192,25,46,0.2)",
                border: "1px solid rgba(255,100,100,0.2)",
              }}>
                <p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 900, color: "#FFB4BD" }}>No payment yet</p>
                <p style={{ margin: 0, fontSize: 10, color: "rgba(255,255,255,0.5)", fontWeight: 600, lineHeight: 1.4 }}>
                  {new Date().toLocaleString("en-US", { month: "long" })} hasn't been logged yet
                </p>
              </div>
            )}
            {/* Streak milestone */}
            {streak >= 3 && (
              <div style={{
                flex: 1, borderRadius: 16, padding: "12px 14px",
                background: "linear-gradient(135deg, #3A2800 0%, #5C4200 100%)",
                boxShadow: "0 4px 14px rgba(200,160,32,0.2)",
                border: "1px solid rgba(255,214,107,0.2)",
              }}>
                <p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 900, color: "#FFD66B" }}>
                  {streak >= 6 ? "On fire! 🔥" : streak >= 4 ? "Great streak! 💪" : "Keep it up! ✨"}
                </p>
                <p style={{ margin: 0, fontSize: 10, color: "rgba(255,255,255,0.5)", fontWeight: 600, lineHeight: 1.4 }}>
                  {streak} months in a row
                </p>
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: "4px 16px 8px" }}>

          {!hasAny && (
            <div style={{ padding: "28px 0 16px", textAlign: "center" }}>
              <p style={{ fontSize: 14, fontWeight: 800, color: "#00314B", margin: "0 0 4px" }}>Nothing new right now</p>
              <p style={{ fontSize: 12, color: "#AAA", margin: 0 }}>No upcoming charges or pending activity.</p>
            </div>
          )}

          {/* ── 1. Overdue / Upcoming ── */}
          {upcoming.length > 0 && (
            <>
              <SectionLabel>Due Soon</SectionLabel>
              {upcoming.map((e) => {
                const overdue = getUrgencyLevel(e) === "overdue";
                const isMandatory = e.mandatory;
                const accent = isMandatory && overdue ? "#C0192E" : overdue ? "#E05C6E" : isMandatory ? "#C0192E" : "#1B5C80";
                const bg = overdue ? "#FFF0F2" : isMandatory ? "#FFF5F6" : "#fff";
                const border = overdue ? "#F8C4CD" : isMandatory ? "#F8A0B0" : "#EDE7DC";
                return (
                  <NotifCard
                    key={e.id}
                    bg={bg} border={border}
                    onClick={() => { onNavigate("urgent"); onClose(); }}
                    left={
                      <Icon path={overdue ? icons.fire : icons.clock} size={18} color={accent} />
                    }
                    title={e.description}
                    sub={isMandatory && overdue ? "⚠ MANDATORY — Overdue" : isMandatory ? `Mandatory · ${dueLabel(e)}` : dueLabel(e)}
                    right={<span style={{ color: accent }}>${camAmt(e).toFixed(2)}</span>}
                  />
                );
              })}
            </>
          )}

          {/* ── 2. Pending confirmation ── */}
          {pending.length > 0 && (
            <>
              <SectionLabel>Awaiting Confirmation</SectionLabel>
              {pending.map((p, i) => (
                <NotifCard
                  key={p.id || i}
                  bg="#FFFBF0" border="#F5E6B0"
                  left={<Icon path={icons.clock} size={18} color="#C48A00" />}
                  title={`Payment via ${p.method || "—"}`}
                  sub={`${formatShortDate(p.date)} · Waiting for Emmanuella`}
                  right={<span style={{ color: "#C48A00" }}>${Number(p.amount || 0).toFixed(2)}</span>}
                  note={p.note}
                />
              ))}
            </>
          )}

          {/* ── 3. Returned payments ── */}
          {returned.length > 0 && (
            <>
              <SectionLabel>Returned by Emmanuella</SectionLabel>
              {returned.map((p, i) => (
                <div key={p.id || i} style={{ background: "#FFF5F0", borderRadius: 16, padding: "13px 14px", marginBottom: 8, border: "1.5px solid #F5C4A0" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 12, background: "#FFF0E0", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Icon path={icons.alert} size={18} color="#E07A20" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "#0A1E2B" }}>
                        Payment returned · <span style={{ color: "#E07A20" }}>${Number(p.amount || 0).toFixed(2)}</span>
                      </p>
                      <p style={{ margin: "2px 0 0", fontSize: 11, color: "#888", fontWeight: 600 }}>via {p.method || "—"} · {formatShortDate(p.date)}</p>
                    </div>
                  </div>
                  {p.rejectionReason && (
                    <div style={{ marginTop: 8, background: "#FFF0E0", borderRadius: 10, padding: "8px 10px", border: "1px solid #F5C4A0" }}>
                      <p style={{ margin: "0 0 2px", fontSize: 10, fontWeight: 800, color: "#E07A20", textTransform: "uppercase", letterSpacing: 0.5 }}>Emmanuella's note</p>
                      <p style={{ margin: 0, fontSize: 12, color: "#555", lineHeight: 1.5, fontStyle: "italic" }}>"{p.rejectionReason}"</p>
                    </div>
                  )}
                  {p.rejectionSuggestionKey && (
                    <p style={{ margin: "6px 0 0", fontSize: 11, color: "#1B5C80", fontWeight: 700 }}>
                      → Apply to: {p.rejectionSuggestionKey.replace("grp:", "").replace("exp:", "")}
                    </p>
                  )}
                </div>
              ))}
            </>
          )}

          {/* ── 4. Recently confirmed ── */}
          {recentlyConfirmed.length > 0 && (
            <>
              <SectionLabel>Payment Confirmed</SectionLabel>
              {recentlyConfirmed.map((p, i) => (
                <NotifCard
                  key={p.id || i}
                  bg="#F0FBF4" border="#B8D9C5"
                  left={<Icon path={icons.check} size={18} color="#2D7A50" />}
                  title="Payment confirmed ✓"
                  sub={`via ${p.method || "—"} · ${formatShortDate(p.date)}`}
                  right={<span style={{ color: "#2D7A50" }}>${Number(p.amount || 0).toFixed(2)}</span>}
                  note={p.note}
                />
              ))}
            </>
          )}

          {/* ── 5. Recent new charges ── */}
          {recentCharges.length > 0 && (
            <>
              <SectionLabel>Expense Added</SectionLabel>
              {recentCharges.map((e) => {
                const addedDate = e.createdAt?.toDate
                  ? e.createdAt.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric" })
                  : formatShortDate(e.date);
                return (
                  <NotifCard
                    key={e.id}
                    bg="#fff" border="#EDE7DC"
                    onClick={() => { onNavigate("expenses"); onClose(); }}
                    left={<Icon path={icons.plus} size={18} color="#1B5C80" />}
                    title={e.description}
                    sub={`${e.split === "split" ? "Split 50/50" : "Cam pays"} · added ${addedDate}`}
                    right={<span style={{ color: "#00314B" }}>${camAmt(e).toFixed(2)}</span>}
                  />
                );
              })}
            </>
          )}

          {/* ── 6. Amount edited ── */}
          {editedExpenses.length > 0 && (
            <>
              <SectionLabel>Amount Updated</SectionLabel>
              {editedExpenses.map((e) => {
                const wasAmt = Number(e.previousAmount || 0);
                const nowAmt = Number(e.amount || 0);
                const diff = nowAmt - wasAmt;
                const diffColor = diff > 0 ? "#E05C6E" : "#2D7A50";
                const diffLabel = diff > 0 ? `+$${diff.toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
                return (
                  <div key={e.id} style={{ background: "#fff", borderRadius: 16, padding: "13px 14px", marginBottom: 8, border: "1.5px solid #EDE7DC" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 12, background: "#F0F4FA", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <Icon path={icons.edit} size={18} color="#1B5C80" />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "#0A1E2B", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {e.description}
                        </p>
                        <p style={{ margin: "2px 0 0", fontSize: 11, color: "#888", fontWeight: 600 }}>
                          Amount updated · {formatShortDate(e.updatedAt)}
                        </p>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <p style={{ margin: 0, fontSize: 14, fontWeight: 900, color: "#00314B" }}>${camAmt(e).toFixed(2)}</p>
                        <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: diffColor }}>
                          {diffLabel} · was ${(e.split === "split" ? wasAmt / 2 : wasAmt).toFixed(2)}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {/* ── 7. Resolved disputes (accepted + declined) ── */}
          {resolvedDisputes.length > 0 && (
            <>
              <SectionLabel>Dispute Response</SectionLabel>
              {resolvedDisputes.map((p, i) => {
                const accepted = p.disputeStatus === "accepted";
                const bg = accepted ? "#F0FBF4" : "#FFF8F0";
                const border = accepted ? "#B8D9C5" : "#F5DABA";
                const iconColor = accepted ? "#2D7A50" : "#C48A00";
                const iconPath = accepted ? icons.check : icons.flag;
                const iconBg = accepted ? "#E0F5EA" : "#FFF0E0";
                return (
                  <div key={p.id || i} style={{ background: bg, borderRadius: 16, padding: "13px 14px", marginBottom: 8, border: `1.5px solid ${border}` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: (!accepted && p.declineReason) ? 8 : 0 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 12, background: iconBg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <Icon path={iconPath} size={18} color={iconColor} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "#0A1E2B" }}>
                          Dispute {accepted ? "accepted ✓" : "declined"}
                        </p>
                        <p style={{ margin: "2px 0 0", fontSize: 11, color: iconColor, fontWeight: 600 }}>
                          {p.disputeDescription || "charge"} · {formatShortDate(p.date)}
                        </p>
                        {accepted && (
                          <p style={{ margin: "3px 0 0", fontSize: 11, color: "#2D7A50", fontWeight: 600 }}>
                            Emmanuella reviewed and accepted your dispute.
                          </p>
                        )}
                      </div>
                    </div>
                    {!accepted && p.declineReason && (
                      <div style={{ background: "#FFF3E0", border: "1px solid #F5DABA", borderRadius: 10, padding: "8px 10px" }}>
                        <p style={{ margin: "0 0 2px", fontSize: 10, fontWeight: 800, color: "#C48A00", textTransform: "uppercase", letterSpacing: 0.5 }}>Emmanuella's response</p>
                        <p style={{ margin: 0, fontSize: 12, color: "#555", lineHeight: 1.5 }}>"{p.declineReason}"</p>
                      </div>
                    )}
                    {!accepted && !p.declineReason && (
                      <p style={{ margin: 0, fontSize: 12, color: "#999", fontStyle: "italic" }}>The charge stands — no additional reason given.</p>
                    )}
                  </div>
                );
              })}
            </>
          )}

        </div>
      </motion.div>
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
function DashboardScreen({ user, balance, totalOwed, totalPaid, expenses, payments, syncingPayments, urgentCount, targetSummaries, onOpenTarget, onAddExpense, onLogPayment, onQuickPay, onConfirm, onResolveDispute, onRejectPayment, onDeletePendingPayment, onDismissRejectedPayment, onNavigate, onLogout, onSwitchView, viewingAsCam, onLogPaymentForKey, onDisputeExpense }) {
  const pending = payments.filter((p) => !p.confirmed && !p.rejected);
  // Cam dashboard urgent banner improvement: Step 3
  const urgentList = (expenses || []).filter((e) => getUrgencyLevel(e) !== null);
  const overdueCount = urgentList.filter((e) => getUrgencyLevel(e) === "overdue").length;
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchVal, setSearchVal] = useState("");
  const [notifOpen, setNotifOpen] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);
  const [activeCat, setActiveCat] = useState(null);
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


  // Dashboard progress section: plans + one-time targets
  const allTargets = targetSummaries ? Array.from(targetSummaries.values()) : [];
  const planTargets = allTargets.filter((t) => t.key?.startsWith("grp:") && Number(t.charged || 0) !== 0);
  const oneTimeTargets = allTargets.filter((t) => t.key?.startsWith("exp:") && Number(t.remaining || 0) !== 0);

  planTargets.sort((a, b) => Number(b.remaining || 0) - Number(a.remaining || 0));
  oneTimeTargets.sort((a, b) => Number(b.remaining || 0) - Number(a.remaining || 0));

  function catGroup(e) {
    const desc = (e.description || "").toLowerCase();
    // Home keywords take priority over any category label
    const homeKw = ["best buy","bestbuy","rent","utilities","utility","electric","electricity"];
    if (["Household","Utilities","Insurance"].includes(e.category) || homeKw.some(k => desc.includes(k))) return "home";
    if (e.category === "Groceries") return "groceries";
    const grocKw = ["instacart","shipt","wegmans","kroger","whole foods","wholefoods","publix","fresh market","freshmarket"];
    if (grocKw.some(k => desc.includes(k))) return "groceries";
    const foodKw = ["doordash","uber eats","ubereats","grubhub","7-eleven","restaurant","takeout","chipotle","mcdonald","pizza","starbucks","coffee","sushi","taco","burger","wendys","chick-fil","panera","subway","dunkin","applebee","olive garden"];
    if (e.category === "Entertainment" || foodKw.some(k => desc.includes(k))) return "eating";
    return "misc";
  }

  const catTotals = { groceries: { total: 0, count: 0, overdue: false }, eating: { total: 0, count: 0, overdue: false }, home: { total: 0, count: 0, overdue: false }, misc: { total: 0, count: 0, overdue: false } };
  for (const e of (filtered.length ? filtered : sortedByDate)) {
    const grp = catGroup(e);
    const amt = Number(e.amount || 0);
    catTotals[grp].total += e.split === "split" ? amt / 2 : e.split === "ella" ? 0 : amt;
    catTotals[grp].count += 1;
    if (getUrgencyLevel(e) === "overdue") catTotals[grp].overdue = true;
  }

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
        {/* Top row: greeting + action buttons */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={styles.headerSub}>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
            <p style={styles.headerGreet}>
              {(() => {
                const h = new Date().getHours();
                return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
              })()},
            </p>
            <p style={{ ...styles.headerGreet, color: "#1B5C80", marginTop: 1 }}>
              {user === "emma" ? "Emmanuella" : "Cameron"} {user === "emma" ? "✨" : "👋"}
            </p>
          </div>
          {/* Avatar circle */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
            <div style={{
              width: 46, height: 46, borderRadius: "50%",
              background: user === "emma"
                ? "linear-gradient(135deg, #4E635E 0%, #00314B 100%)"
                : "linear-gradient(135deg, #E8A0B0 0%, #C0485A 100%)",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 4px 14px rgba(0,49,75,0.22)",
              border: "2px solid rgba(255,255,255,0.7)",
              flexShrink: 0,
            }}>
              <span style={{ fontSize: 18, fontWeight: 900, color: "#fff", lineHeight: 1 }}>
                {user === "emma" ? "E" : "C"}
              </span>
            </div>
          </div>
        </div>

        {/* Action buttons row */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14 }}>
          <div style={{ flex: 1 }} />
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
              const pendingCount = (payments || []).filter((p) => !p.confirmed && !p.rejected).length;
              const returnedCount = (payments || []).filter((p) => p.rejected).length;
              const badgeCount = upcomingCount + pendingCount + returnedCount;
              return (
                <button
                  type="button"
                  style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: 46, height: 46, borderRadius: "50%", border: "none", background: notifOpen ? "linear-gradient(145deg, #A0253A, #E05C6E)" : "linear-gradient(145deg, #002B42, #1B5C80)", cursor: "pointer", boxShadow: notifOpen ? "0 4px 16px rgba(224,92,110,0.45)" : "0 4px 16px rgba(0,43,66,0.35)" }}
                  onClick={() => setNotifOpen((o) => !o)}
                  aria-label="Notifications"
                >
                  <Icon path={icons.bell} size={22} color="#fff" />
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
      {!Capacitor.isNativePlatform() && (!tokenSaved || notifPermission !== "granted") && (
        <NotifEnableBanner user={user} notifPermission={notifPermission} setNotifPermission={setNotifPermission} setTokenSaved={setTokenSaved} />
      )}

      {/* Balance Banner — Emma */}
      {user === "emma" && (
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



      {/* Insights strip — streak, forecast, sparkline */}
      <InsightsStrip payments={payments} expenses={expenses} balance={balance} />

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
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          style={{
            margin: "12px 16px 0",
            background: "linear-gradient(135deg, #4A0E1A 0%, #7A1830 100%)",
            borderRadius: 20,
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            cursor: "pointer",
            boxShadow: "0 8px 24px rgba(224,92,110,0.28), inset 0 1px 0 rgba(255,255,255,0.1)",
            border: "1px solid rgba(255,100,120,0.25)",
          }}
          onClick={() => onNavigate("urgent")}
          role="button"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 14,
              background: "rgba(255,255,255,0.12)",
              border: "1px solid rgba(255,255,255,0.15)",
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            }}>
              <Icon path={icons.fire} size={20} color="#FFB4BD" />
            </div>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 900, color: "#fff", letterSpacing: -0.2 }}>
                {`${urgentCount} payment${urgentCount === 1 ? "" : "s"} due soon`}
              </p>
              <p style={{ margin: "2px 0 0", fontSize: 11, color: "rgba(255,255,255,0.6)", fontWeight: 600 }}>
                Tap to see what needs attention
              </p>
            </div>
          </div>
          <Icon path={icons.forward} size={18} color="rgba(255,255,255,0.6)" />
        </motion.div>
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


      {/* ── Category Spending Grid ── */}
      <div style={{ margin: "20px 16px 20px" }}>

        {/* Section header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <span style={{ fontSize: 17, fontWeight: 900, color: "#0A1E2B", letterSpacing: -0.4 }}>Spending</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#A6B7CB", marginLeft: 8 }}>
              {new Date().toLocaleString("en-US", { month: "long" })}
            </span>
          </div>
          <button
            style={{ background: "rgba(0,49,75,0.07)", border: "none", fontSize: 11, fontWeight: 800, color: "#1B5C80", cursor: "pointer", padding: "5px 12px", borderRadius: 20 }}
            onClick={() => onNavigate("expenses")}
          >
            See all →
          </button>
        </div>

        {/* 2×2 filled category tiles — upgraded */}
        {(() => {
          const TILES = [
            {
              id: "groceries",
              label: "Groceries",
              bg: "linear-gradient(150deg, #2D4A44 0%, #4E7A72 100%)",
              glow: "rgba(61,90,84,0.35)",
              accent: "#7ECDB8",
              icon: (c) => (
                <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
                  <line x1="3" y1="6" x2="21" y2="6"/>
                  <path d="M16 10a4 4 0 01-8 0"/>
                </svg>
              ),
            },
            {
              id: "eating",
              label: "Eating Out",
              bg: "linear-gradient(150deg, #5C3A1E 0%, #9B6A36 100%)",
              glow: "rgba(122,92,58,0.35)",
              accent: "#F5C87A",
              icon: (c) => (
                <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/>
                  <path d="M7 2v20"/>
                  <path d="M21 15V2a5 5 0 00-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/>
                </svg>
              ),
            },
            {
              id: "home",
              label: "Home",
              bg: "linear-gradient(150deg, #002238 0%, #0B4A70 100%)",
              glow: "rgba(0,49,75,0.4)",
              accent: "#7EC8E3",
              icon: (c) => (
                <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <path d={icons.home}/>
                </svg>
              ),
            },
            {
              id: "misc",
              label: "Misc",
              bg: "linear-gradient(150deg, #2A3F52 0%, #446480 100%)",
              glow: "rgba(58,85,104,0.35)",
              accent: "#A8C4DC",
              icon: (c) => (
                <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1.5"/>
                  <rect x="14" y="3" width="7" height="7" rx="1.5"/>
                  <rect x="14" y="14" width="7" height="7" rx="1.5"/>
                  <rect x="3" y="14" width="7" height="7" rx="1.5"/>
                </svg>
              ),
            },
          ];
          const maxTotal = Math.max(...TILES.map(t => catTotals[t.id].total), 1);
          return (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              {TILES.map((tile, idx) => {
                const data = catTotals[tile.id];
                const isEmpty = data.count === 0;
                const fillPct = isEmpty ? 0 : Math.min(1, data.total / maxTotal);
                return (
                  <motion.div
                    key={tile.id}
                    onClick={() => setActiveCat(tile.id)}
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ type: "spring", stiffness: 320, damping: 26, delay: idx * 0.06 }}
                    whileTap={{ scale: 0.93 }}
                    style={{
                      background: isEmpty ? "rgba(220,218,214,0.55)" : tile.bg,
                      borderRadius: 24,
                      padding: "18px 16px 14px",
                      boxShadow: isEmpty ? "none" : `0 8px 28px ${tile.glow}, 0 2px 6px rgba(0,0,0,0.12)`,
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      minHeight: 148,
                      position: "relative",
                      overflow: "hidden",
                      opacity: isEmpty ? 0.55 : 1,
                    }}
                  >
                    {/* Subtle shine overlay */}
                    {!isEmpty && (
                      <div style={{
                        position: "absolute", top: 0, left: 0, right: 0, height: "50%",
                        background: "linear-gradient(180deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0) 100%)",
                        borderRadius: "24px 24px 0 0", pointerEvents: "none",
                      }} />
                    )}

                    {/* Icon bubble */}
                    <div style={{
                      width: 46, height: 46, borderRadius: 16,
                      background: isEmpty ? "rgba(0,0,0,0.07)" : "rgba(255,255,255,0.16)",
                      border: isEmpty ? "none" : "1px solid rgba(255,255,255,0.2)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      marginBottom: "auto",
                    }}>
                      {tile.icon(isEmpty ? "rgba(0,0,0,0.22)" : "rgba(255,255,255,0.92)")}
                    </div>

                    {/* Label + amount */}
                    <div style={{ marginTop: 12 }}>
                      <p style={{ margin: 0, fontSize: 10, fontWeight: 800, color: isEmpty ? "rgba(0,0,0,0.28)" : "rgba(255,255,255,0.6)", letterSpacing: 1, textTransform: "uppercase" }}>
                        {tile.label}
                      </p>
                      <p style={{ margin: "3px 0 0", fontSize: 20, fontWeight: 900, color: isEmpty ? "rgba(0,0,0,0.18)" : "#fff", letterSpacing: -0.8 }}>
                        {isEmpty ? "—" : `$${data.total.toFixed(2)}`}
                      </p>
                    </div>

                    {/* Progress bar at bottom */}
                    {!isEmpty && (
                      <div style={{ marginTop: 10, height: 3, borderRadius: 999, background: "rgba(255,255,255,0.18)", overflow: "hidden" }}>
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${fillPct * 100}%` }}
                          transition={{ duration: 0.7, delay: 0.2 + idx * 0.08, ease: "easeOut" }}
                          style={{ height: "100%", borderRadius: 999, background: tile.accent }}
                        />
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </div>
          );
        })()}

        {/* Plan progress — expandable section below grid */}
        {!tokens.length && (planTargets.length > 0 || oneTimeTargets.length > 0) && (
          <div style={{ marginTop: 16, background: "#fff", borderRadius: 22, border: "1.5px solid #EDE7DC", boxShadow: "0 2px 16px rgba(0,49,75,0.07)", overflow: "hidden" }}>
            <button
              type="button"
              onClick={() => setPlansOpen(o => !o)}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "13px 16px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 28, height: 28, borderRadius: 10, background: plansOpen ? "#EDE7DC" : "#EEE9E0", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#A6B7CB" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
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
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#D5BD96" strokeWidth={2.5} strokeLinecap="round" style={{ transform: plansOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.25s ease" }}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
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
                              style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 11px", borderRadius: 999, cursor: "pointer", background: isPaid ? "#EBF0E8" : "#EEE9E0", border: `1.5px solid ${isPaid ? "#B8CDB5" : "#DDD5C5"}` }}
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

      {/* Pending Payments — bottom strip (Emma only) */}
      {user === "emma" && (
        <div style={{ margin: "4px 16px 24px" }}>
          <DashboardPendingCard
            user={user}
            pendingPayments={pending}
            onConfirm={onConfirm}
            onResolveDispute={onResolveDispute}
            onRejectPayment={onRejectPayment}
            onDeletePendingPayment={onDeletePendingPayment}
            targetSummaries={targetSummaries}
            expenses={expenses}
          />
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

      <AnimatePresence>
        {activeCat && (
          <CategoryAnalyticsSheet
            catId={activeCat}
            expenses={expenses || []}
            catGroup={catGroup}
            onClose={() => setActiveCat(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── CATEGORY ANALYTICS SHEET ─────────────────────────────────────────
const CAT_META = {
  groceries: { label: "Groceries", bg: "linear-gradient(145deg, #3D5A54, #5E8278)", color: "#3D5A54", light: "#EAF0EE" },
  eating:    { label: "Eating Out", bg: "linear-gradient(145deg, #7A5C3A, #A8804E)", color: "#7A5C3A", light: "#F2EDE6" },
  home:      { label: "Home",       bg: "linear-gradient(145deg, #00314B, #1B5C80)", color: "#00314B", light: "#E5EEF4" },
  misc:      { label: "Misc",       bg: "linear-gradient(145deg, #3A5568, #56788E)", color: "#3A5568", light: "#EAEEf2" },
};

function CategoryAnalyticsSheet({ catId, expenses, catGroup, onClose }) {
  const meta = CAT_META[catId] || CAT_META.misc;

  // All expenses in this category (unpaid)
  const catExps = expenses.filter(e => catGroup(e) === catId);

  function share(e) {
    const a = Number(e.amount || 0);
    if (e.split === "ella") return 0;
    return e.split === "split" ? a / 2 : a;
  }

  const total = catExps.reduce((s, e) => s + share(e), 0);
  const avg   = catExps.length ? total / catExps.length : 0;
  const biggest = catExps.reduce((b, e) => share(e) > share(b || { amount: 0 }) ? e : b, null);

  // Monthly totals — last 5 months
  const now = new Date();
  const months = Array.from({ length: 5 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (4 - i), 1);
    return {
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString("en-US", { month: "short" }),
      total: 0,
    };
  });
  for (const e of catExps) {
    const mo = (e.date || "").slice(0, 7);
    const slot = months.find(m => m.key === mo);
    if (slot) slot.total += share(e);
  }
  const maxMo = Math.max(...months.map(m => m.total), 1);

  // Recent transactions sorted newest first
  const sorted = [...catExps].sort((a, b) => new Date(b.date) - new Date(a.date));

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 900 }} />
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 340, damping: 34 }}
        style={{
          position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
          width: "100%", maxWidth: 430, zIndex: 901,
          borderRadius: "26px 26px 0 0", overflow: "hidden",
          background: "#F7F4EF", paddingBottom: "max(28px, env(safe-area-inset-bottom))",
          maxHeight: "90vh", display: "flex", flexDirection: "column",
          boxShadow: "0 -8px 40px rgba(0,0,0,0.22)",
        }}
      >
        {/* Gradient header */}
        <div style={{ background: meta.bg, padding: "20px 20px 24px", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
            <div style={{ width: 40, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.35)" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.6)", textTransform: "uppercase", letterSpacing: 1 }}>Spending</p>
              <p style={{ margin: "2px 0 0", fontSize: 26, fontWeight: 900, color: "#fff", letterSpacing: -0.5 }}>{meta.label}</p>
            </div>
            <button onClick={onClose} type="button"
              style={{ background: "rgba(255,255,255,0.2)", border: "none", borderRadius: 10, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
              <Icon path={icons.x} size={18} color="#fff" />
            </button>
          </div>

          {/* Key stat row */}
          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            {[
              { label: "Total", value: `$${total.toFixed(2)}` },
              { label: "Items", value: catExps.length },
              { label: "Avg", value: catExps.length ? `$${avg.toFixed(2)}` : "—" },
            ].map(s => (
              <div key={s.label} style={{ flex: 1, background: "rgba(255,255,255,0.15)", borderRadius: 14, padding: "10px 12px" }}>
                <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.6)", textTransform: "uppercase", letterSpacing: 0.8 }}>{s.label}</p>
                <p style={{ margin: "4px 0 0", fontSize: 18, fontWeight: 900, color: "#fff" }}>{s.value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: "auto", flex: 1, padding: "20px 20px 8px" }}>

          {/* Monthly bar chart */}
          <p style={{ margin: "0 0 12px", fontSize: 11, fontWeight: 700, color: "#BBB", textTransform: "uppercase", letterSpacing: 1 }}>Monthly Trend</p>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 110, marginBottom: 24 }}>
            {months.map(m => {
              const pct = m.total / maxMo;
              const isCurrent = m.key === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
              return (
                <div key={m.key} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <p style={{ margin: 0, fontSize: 9, fontWeight: 700, color: meta.color, opacity: m.total ? 1 : 0, lineHeight: 1 }}>
                    ${m.total > 0 ? (m.total >= 100 ? Math.round(m.total) : m.total.toFixed(0)) : ""}
                  </p>
                  <div style={{ width: "100%", borderRadius: 8, overflow: "hidden", flex: 1, display: "flex", alignItems: "flex-end", background: "#EDE9E2" }}>
                    <div style={{
                      width: "100%", borderRadius: 8,
                      height: `${Math.max(pct * 100, m.total > 0 ? 5 : 0)}%`,
                      background: isCurrent ? meta.bg : `${meta.color}44`,
                      transition: "height 0.5s ease",
                      boxShadow: isCurrent ? `0 -2px 8px ${meta.color}44` : "none",
                    }} />
                  </div>
                  <p style={{ margin: 0, fontSize: 10, fontWeight: isCurrent ? 800 : 600, color: isCurrent ? meta.color : "#BBB" }}>{m.label}</p>
                </div>
              );
            })}
          </div>

          {/* Biggest expense */}
          {biggest && (
            <>
              <p style={{ margin: "0 0 10px", fontSize: 11, fontWeight: 700, color: "#BBB", textTransform: "uppercase", letterSpacing: 1 }}>Biggest Charge</p>
              <div style={{ background: meta.light, borderRadius: 16, padding: "12px 14px", marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "#0A1E2B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{biggest.description}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 11, color: "#999", fontWeight: 600 }}>{biggest.date}</p>
                </div>
                <p style={{ margin: 0, fontSize: 18, fontWeight: 900, color: meta.color, marginLeft: 12, flexShrink: 0 }}>${share(biggest).toFixed(2)}</p>
              </div>
            </>
          )}

          {/* Transaction list */}
          <p style={{ margin: "0 0 10px", fontSize: 11, fontWeight: 700, color: "#BBB", textTransform: "uppercase", letterSpacing: 1 }}>All Transactions</p>
          {sorted.length === 0 && (
            <p style={{ fontSize: 13, color: "#CCC", textAlign: "center", padding: "24px 0" }}>No transactions yet.</p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 8 }}>
            {sorted.map((e, i) => (
              <div key={e.id} style={{ background: "#fff", borderRadius: 14, overflow: "hidden", display: "flex", boxShadow: "0 2px 8px rgba(0,0,0,0.06)", position: "relative" }}>
                {/* Left accent stripe */}
                <div style={{ width: 4, flexShrink: 0, background: i === 0 ? meta.bg : `${meta.color}55` }} />
                <div style={{ flex: 1, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "#0A1E2B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.description}</p>
                    <p style={{ margin: "2px 0 0", fontSize: 11, color: "#BBB", fontWeight: 600 }}>{e.date}{e.split === "split" ? " · split 50/50" : ""}</p>
                  </div>
                  <p style={{ margin: 0, fontSize: 18, fontWeight: 900, color: meta.color, marginLeft: 12, flexShrink: 0, letterSpacing: -0.4 }}>${share(e).toFixed(2)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </motion.div>
    </>
  );
}

// ── URGENT SCREEN ────────────────────────────────────────────────────
function UrgentScreen({ expenses, allExpenses = [], user, onBack, onMarkPaid, onLogPaymentForKey }) {
  const isCam = user === "cam";
  const [tab, setTab] = useState("urgent"); // "urgent" | "mandatory"
  const [expandedId, setExpandedId] = useState(null);
  const tabRef = useRef(null);
  const [pillStyle, setPillStyle] = useState({ left: 0, width: 0 });
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);

  const tabs = [
    { id: "urgent", label: "Urgent" },
    { id: "mandatory", label: "Mandatory" },
  ];

  useEffect(() => {
    if (!tabRef.current) return;
    const container = tabRef.current;
    const idx = tabs.findIndex(t => t.id === tab);
    const btn = container.children[idx + 1]; // +1 to skip the pill div
    if (!btn) return;
    const cRect = container.getBoundingClientRect();
    const bRect = btn.getBoundingClientRect();
    setPillStyle({ left: bRect.left - cRect.left, width: bRect.width });
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Urgent: overdue/due soon
  const urgentSorted = [...expenses].sort(
    (a, b) => (getDaysUntilDue(a.nextDue || a.dueDate) ?? 999) - (getDaysUntilDue(b.nextDue || b.dueDate) ?? 999)
  );

  // Mandatory: expenses explicitly marked as mandatory, sorted by next due date
  const mandatorySorted = [...allExpenses]
    .filter(e => e.mandatory)
    .sort((a, b) => {
      const da = getDaysUntilDue(a.nextDue || a.dueDate) ?? 999;
      const db = getDaysUntilDue(b.nextDue || b.dueDate) ?? 999;
      return da - db;
    });

  const list = tab === "urgent" ? urgentSorted : mandatorySorted;

  function renderExpenseCard(e, idx, arr) {
    const level = getUrgencyLevel(e);
    const days = getDaysUntilDue(e.nextDue || e.dueDate);
    const isExpanded = expandedId === e.id;
    const camAmt = e.split === "cam" ? Number(e.amount) : e.split === "split" ? Number(e.amount) / 2 : 0;
    const isLast = idx === arr.length - 1;

    // Dark gradient per urgency level
    const gradient = level === "overdue"
      ? "linear-gradient(145deg, #3A0A14 0%, #7A1830 100%)"
      : level === "critical"
        ? "linear-gradient(145deg, #2D1500 0%, #7A3800 100%)"
        : level === "warning"
          ? "linear-gradient(145deg, #1A1800 0%, #4A4200 100%)"
          : "linear-gradient(145deg, #001828 0%, #003559 100%)";

    const accentColor = level === "overdue" ? "#FF6B7A"
      : level === "critical" ? "#FF9040"
      : level === "warning" ? "#F0CC40"
      : "#7AB8D8";

    const dotColor = level === "overdue" ? "#E05C6E"
      : level === "critical" ? "#E07820"
      : level === "warning" ? "#C8A020"
      : "#7A9BB5";

    const countNum = days === null ? null : Math.abs(days);
    const countLabel = days === null ? null
      : days < 0 ? "days overdue"
      : days === 0 ? "due today"
      : days === 1 ? "due tomorrow"
      : "days left";

    const recurLabel = e.recurring && e.recurring !== "none"
      ? ({ monthly: "Monthly", weekly: "Weekly", biweekly: "Every 2 wks", yearly: "Yearly", quarterly: "Quarterly" }[e.recurring] || e.recurring)
      : null;

    return (
      <div key={e.id} style={{ display: "flex", gap: 0, marginBottom: 0 }}>
        {/* Timeline column */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 36, flexShrink: 0 }}>
          {/* Dot */}
          <div style={{
            width: 14, height: 14, borderRadius: "50%", flexShrink: 0, marginTop: 20,
            background: dotColor,
            boxShadow: `0 0 0 3px rgba(${level === "overdue" ? "224,92,110" : level === "critical" ? "224,120,32" : level === "warning" ? "200,160,32" : "122,155,181"}, 0.25)`,
            zIndex: 1,
          }} />
          {/* Line below dot */}
          {!isLast && (
            <div style={{ flex: 1, width: 2, background: "rgba(0,0,0,0.08)", marginTop: 4, marginBottom: 4, borderRadius: 1 }} />
          )}
        </div>

        {/* Card */}
        <div style={{ flex: 1, marginBottom: isLast ? 0 : 10 }}>
          <div
            style={{
              background: gradient,
              borderRadius: 20,
              overflow: "hidden",
              cursor: "pointer",
              boxShadow: isExpanded
                ? `0 8px 28px rgba(0,0,0,0.35), 0 0 0 1.5px ${accentColor}55`
                : "0 4px 16px rgba(0,0,0,0.22)",
            }}
            onClick={() => setExpandedId(isExpanded ? null : e.id)}
          >
            <div style={{ display: "flex", alignItems: "stretch", gap: 0, padding: "16px 16px 14px" }}>

              {/* Countdown block */}
              {countNum !== null && (
                <div style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  minWidth: 58, marginRight: 14, flexShrink: 0,
                  background: "rgba(255,255,255,0.07)", borderRadius: 14, padding: "8px 6px",
                }}>
                  <span style={{ fontSize: days === 0 ? 18 : 30, fontWeight: 900, color: accentColor, lineHeight: 1, letterSpacing: -1 }}>
                    {days === 0 ? "NOW" : days === 1 ? "1" : countNum}
                  </span>
                  <span style={{ fontSize: 9, fontWeight: 700, color: "rgba(255,255,255,0.45)", textTransform: "uppercase", letterSpacing: 0.4, textAlign: "center", marginTop: 3, lineHeight: 1.2 }}>
                    {countLabel}
                  </span>
                </div>
              )}

              {/* Main content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: "0 0 3px", fontSize: 10, fontWeight: 700, color: accentColor, textTransform: "uppercase", letterSpacing: 0.8 }}>
                      {level === "overdue" ? "Overdue" : level === "critical" ? "Due Soon" : level === "warning" ? "Upcoming" : "Scheduled"}
                      {recurLabel && <span style={{ color: "rgba(255,255,255,0.35)", marginLeft: 5 }}>· {recurLabel}</span>}
                    </p>
                    <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {e.description}
                    </p>
                    <p style={{ margin: "3px 0 0", fontSize: 11, color: "rgba(255,255,255,0.4)", fontWeight: 500 }}>
                      {[e.account, e.category].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  {/* Amount */}
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <p style={{ margin: 0, fontSize: 22, fontWeight: 900, color: "#fff", letterSpacing: -0.8, lineHeight: 1 }}>
                      ${Number(e.amount || 0).toFixed(2)}
                    </p>
                    {camAmt > 0 && (
                      <p style={{ margin: "3px 0 0", fontSize: 11, fontWeight: 700, color: "#FFB3C8" }}>
                        {isCam ? "you" : "cam"} ${camAmt.toFixed(2)}
                      </p>
                    )}
                  </div>
                </div>

                {/* Due date row */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
                  {(e.nextDue || e.dueDate) && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.45)" }}>
                      {days < 0 ? "Was due" : "Due"} {formatShortDate(e.nextDue || e.dueDate)}
                    </span>
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
                    {user === "emma" && !e._optimistic && (
                      <button
                        style={{ padding: "5px 12px", borderRadius: 8, border: "none", background: "rgba(255,255,255,0.15)", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                        onClick={(ev) => { ev.stopPropagation(); onMarkPaid(e.id); }}
                      >
                        Mark paid
                      </button>
                    )}
                    <Icon path={isExpanded ? icons.chevronUp : icons.chevronDown} size={14} color="rgba(255,255,255,0.35)" />
                  </div>
                </div>
              </div>
            </div>

            {/* Expand panel */}
            {isExpanded && (
              <div
                style={{ borderTop: "1px solid rgba(255,255,255,0.08)", padding: "12px 16px 16px", background: "rgba(0,0,0,0.25)" }}
                onClick={(ev) => ev.stopPropagation()}
              >
                {e.referenceNum && (
                  <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", margin: "0 0 10px" }}>
                    <span style={{ fontWeight: 700, color: "rgba(255,255,255,0.8)" }}>Ref #</span> {e.referenceNum}
                  </p>
                )}

                {/* Note — inline editable */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                    <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: 0.4 }}>Note</p>
                    {editingNoteId !== e.id && (
                      <button
                        type="button"
                        onClick={() => { setEditingNoteId(e.id); setNoteDraft(e.note || ""); }}
                        style={{ background: "rgba(255,255,255,0.1)", border: "none", borderRadius: 7, padding: "3px 9px", fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.6)", cursor: "pointer" }}
                      >
                        {e.note ? "Edit" : "+ Add note"}
                      </button>
                    )}
                  </div>

                  {editingNoteId === e.id ? (
                    <div>
                      <textarea
                        autoFocus
                        value={noteDraft}
                        onChange={(ev) => setNoteDraft(ev.target.value)}
                        placeholder="Write a note…"
                        rows={3}
                        style={{
                          width: "100%", boxSizing: "border-box",
                          background: "rgba(255,255,255,0.08)",
                          border: `1.5px solid ${accentColor}55`,
                          borderRadius: 10, padding: "9px 11px",
                          fontSize: 13, color: "#fff", fontFamily: "inherit",
                          resize: "none", outline: "none",
                        }}
                      />
                      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                        <button
                          type="button"
                          disabled={noteSaving}
                          onClick={async () => {
                            setNoteSaving(true);
                            try { await updateExpenseInDb(e.id, { note: noteDraft }); } catch (_) {}
                            setNoteSaving(false);
                            setEditingNoteId(null);
                          }}
                          style={{ flex: 1, padding: "9px", borderRadius: 9, border: "none", background: accentColor, color: "#000", fontSize: 12, fontWeight: 800, cursor: "pointer" }}
                        >
                          {noteSaving ? "Saving…" : "Save"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingNoteId(null)}
                          style={{ padding: "9px 14px", borderRadius: 9, border: "none", background: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.6)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : e.note ? (
                    <p style={{ margin: 0, fontSize: 13, color: "rgba(255,255,255,0.75)", lineHeight: 1.5 }}>{e.note}</p>
                  ) : (
                    <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.25)", fontStyle: "italic" }}>No note yet.</p>
                  )}
                </div>
                {e.receiptUrl && (
                  <div style={{ marginBottom: 10, borderRadius: 12, overflow: "hidden" }}>
                    <img src={e.receiptUrl} alt="Receipt" style={{ display: "block", width: "100%", maxHeight: 200, objectFit: "cover" }} />
                  </div>
                )}
                {isCam && typeof onLogPaymentForKey === "function" && (
                  <button
                    style={{ width: "100%", padding: "12px", borderRadius: 12, border: "none", background: accentColor, color: "#000", fontSize: 13, fontWeight: 800, cursor: "pointer", letterSpacing: 0.2 }}
                    onClick={() => onLogPaymentForKey(`exp:${e.id}`, camAmt > 0 ? camAmt : Number(e.amount))}
                  >
                    Log Payment →
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.screen}>
      <div style={styles.subHeader}>
        <button
          type="button"
          style={{ ...styles.logoutBtn, display: "flex", alignItems: "center", justifyContent: "center", padding: "6px 12px", minWidth: 40, height: 32, background: "rgba(255,255,255,0.7)", color: "#00314B" }}
          onClick={onBack}
          aria-label="Back"
        >
          <Icon path={icons.back} size={18} color="#00314B" />
        </button>
        <h2 style={{ ...styles.subTitle, flex: 1, textAlign: "center", minWidth: 0 }}>
          {tab === "urgent" ? "Urgent" : "Mandatory"}
        </h2>
        <div style={{ minWidth: 40, height: 32 }} />
      </div>

      {/* Sliding pill toggle */}
      <div style={{ padding: "0 16px 16px" }}>
        <div
          ref={tabRef}
          style={{ position: "relative", display: "flex", background: "rgba(166,180,158,0.13)", borderRadius: 14, padding: 4, gap: 0 }}
        >
          {/* Sliding pill */}
          <div
            style={{
              position: "absolute",
              top: 4,
              height: "calc(100% - 8px)",
              left: pillStyle.width ? pillStyle.left : (tab === "urgent" ? 4 : "50%"),
              width: pillStyle.width || "50%",
              background: tab === "urgent"
                ? "linear-gradient(135deg, #E05C6E, #C0485A)"
                : "linear-gradient(135deg, #A6B49E, #4E635E)",
              borderRadius: 10,
              transition: "left 0.38s cubic-bezier(0.34,1.56,0.64,1), width 0.38s cubic-bezier(0.34,1.56,0.64,1), background 0.3s ease",
              boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
              pointerEvents: "none",
            }}
          />
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => { setTab(t.id); setExpandedId(null); }}
              style={{
                flex: 1,
                padding: "9px 0",
                border: "none",
                background: "transparent",
                color: tab === t.id ? "#fff" : "#888",
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
                borderRadius: 10,
                position: "relative",
                zIndex: 1,
                transition: "color 0.25s ease",
              }}
            >
              {t.label}
              {t.id === "urgent" && expenses.length > 0 && (
                <span style={{ marginLeft: 5, background: tab === "urgent" ? "rgba(255,255,255,0.3)" : "#E05C6E", color: "#fff", borderRadius: 999, fontSize: 10, fontWeight: 800, padding: "1px 6px" }}>
                  {expenses.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: "0 16px" }}>
        {list.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <p style={{ fontSize: 48, margin: 0 }}>{tab === "urgent" ? "✅" : "📋"}</p>
            <p style={{ fontWeight: 700, color: "#00314B", fontSize: 18, margin: "12px 0 4px" }}>
              {tab === "urgent" ? "All clear!" : "No recurring bills"}
            </p>
            <p style={{ color: "#999", fontSize: 13, margin: 0 }}>
              {tab === "urgent" ? "No overdue or upcoming payments" : "Add recurring expenses to see them here"}
            </p>
          </div>
        ) : (
          <div style={{ position: "relative" }}>
            {/* Continuous timeline line behind all cards */}
            <div style={{
              position: "absolute",
              left: 17, top: 27, bottom: 20,
              width: 2,
              background: "linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.04) 100%)",
              borderRadius: 1,
              pointerEvents: "none",
            }} />
            {list.map((e, idx, arr) => renderExpenseCard(e, idx, arr))}
          </div>
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
  // One-time paid expenses are excluded entirely — they only live in History.
  const baseList = (() => {
    const list = (expenses || []).filter(e => {
      const isRecurring = e.recurring && e.recurring !== "none";
      if (!isRecurring && e.status === "paid") return false;
      return true;
    });
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
  function buildGrouped(list) {
    const result = [];
    const seen = new Map();
    for (const e of list) {
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
  }

  const groupedList = buildGrouped(listToRender);

  // ---- Mandatory section — always pinned, not affected by status filter ----
  // One-time paid mandatory expenses are hidden here (they live in history).
  // Recurring mandatory expenses stay pinned regardless of paid status.
  const pinnedMandatoryGrouped = (() => {
    const sorted = applySort(baseList.filter(e => {
      if (!e.mandatory) return false;
      const isRecurring = e.recurring && e.recurring !== "none";
      if (!isRecurring && e.status === "paid") return false;
      return true;
    }));
    return buildGrouped(sorted);
  })();

  // IDs/gids already in pinned mandatory — exclude from regular section
  const pinnedIds = new Set(
    pinnedMandatoryGrouped.map(item => item._isGroup ? `grp:${item.gid}` : item.id)
  );
  const regularGroupedList = groupedList.filter(item =>
    !pinnedIds.has(item._isGroup ? `grp:${item.gid}` : item.id)
  );


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
      padding: "calc(env(safe-area-inset-top, 47px) + 12px) 16px 12px",
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

          {/* Cam summary card — redesigned */}
          {isCam && (
            <div style={{ padding: "0 12px 12px" }}>
              <div style={{
                background: "linear-gradient(145deg, #00253A 0%, #1A4D6B 100%)",
                borderRadius: 20,
                padding: "16px 16px 0",
                boxShadow: "0 10px 30px rgba(0,37,58,0.28)",
                overflow: "hidden",
              }}>
                {/* Top stat row */}
                <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                  {/* Still Owe */}
                  <div style={{ flex: 1, background: "rgba(255,255,255,0.07)", borderRadius: 14, padding: "12px 14px" }}>
                    <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.45)", textTransform: "uppercase", letterSpacing: 0.6 }}>Still Owe</p>
                    <p style={{ margin: 0, fontSize: 24, fontWeight: 900, letterSpacing: -0.8, color: "#FFB3B3", lineHeight: 1 }}>
                      ${camChargeSummary.totalOwed.toFixed(2)}
                    </p>
                  </div>
                  {/* Paid So Far */}
                  <div style={{ flex: 1, background: "rgba(255,255,255,0.07)", borderRadius: 14, padding: "12px 14px" }}>
                    <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.45)", textTransform: "uppercase", letterSpacing: 0.6 }}>Paid So Far</p>
                    <p style={{ margin: 0, fontSize: 24, fontWeight: 900, letterSpacing: -0.8, color: "#A8EFC4", lineHeight: 1 }}>
                      ${camChargeSummary.totalPaid.toFixed(2)}
                    </p>
                  </div>
                </div>

                {/* Progress bar + footer row */}
                <div style={{ margin: "0 -16px", background: "rgba(0,0,0,0.25)", padding: "10px 16px 12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", fontWeight: 600 }}>{camChargePct}% cleared</span>
                      {camChargeSummary.overdueCount > 0 && (
                        <span style={{ fontSize: 10, fontWeight: 800, background: "rgba(224,92,110,0.25)", color: "#FFB3B3", borderRadius: 6, padding: "2px 8px" }}>
                          {camChargeSummary.overdueCount} overdue
                        </span>
                      )}
                    </div>
                    {camChargeSummary.totalOwed > 0 && (
                      <button
                        type="button"
                        onClick={() => typeof onLogPaymentForKey === "function" && onLogPaymentForKey("general", camChargeSummary.totalOwed)}
                        style={{ background: "linear-gradient(135deg, #E05C6E, #C0485A)", border: "none", borderRadius: 10, padding: "6px 14px", fontSize: 12, fontWeight: 800, color: "#fff", cursor: "pointer", letterSpacing: 0.2 }}
                      >
                        Pay Now →
                      </button>
                    )}
                  </div>
                  <div style={{ background: "rgba(255,255,255,0.12)", borderRadius: 6, height: 6, overflow: "hidden" }}>
                    <div style={{ height: "100%", borderRadius: 6, background: "linear-gradient(90deg, #A8EFC4, #4DBF88)", width: `${camChargePct}%`, transition: "width 0.5s ease" }} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Filter chips */}
          {!search.searchActive && (
            <div style={{ ...island.filterRow, WebkitOverflowScrolling: "touch", scrollbarWidth: "none", msOverflowStyle: "none" }}>
              {(isCam
                ? [["all","All","#7A9BB5"],["unpaid","Unpaid","#E8A0B0"],["overdue","Overdue","#E05C6E"],["installments","Plans","#5B6EBD"],["paid","Paid","#4E8040"]]
                : [["all","All","#7A9BB5"],["unpaid","Unpaid","#E8A0B0"],["overdue","Overdue","#E05C6E"],["paid","Paid","#4E8040"]]
              ).map(([val, label, accentColor]) => {
                const isActive = statusFilter === val;
                return (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setStatusFilter(val)}
                    style={{
                      flexShrink: 0,
                      display: "flex", alignItems: "center", gap: 5,
                      padding: "8px 16px",
                      borderRadius: 999,
                      border: isActive ? "none" : "1.5px solid #E8E0D5",
                      background: isActive ? accentColor : "#fff",
                      fontSize: 13,
                      fontWeight: 800,
                      color: isActive ? "#fff" : "#999",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      transition: "all 0.2s ease",
                      transform: isActive ? "scale(1.05)" : "scale(1)",
                      boxShadow: isActive ? `0 4px 12px ${accentColor}55` : "none",
                    }}
                  >
                    {!isActive && (
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: accentColor, flexShrink: 0 }} />
                    )}
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Sort dropdown */}
          {!search.searchActive && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 12px 10px" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#AAA", textTransform: "uppercase", letterSpacing: 0.5, flexShrink: 0 }}>Sort</span>
              <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
                <select
                  value={sortBy}
                  onChange={(ev) => setSortBy(ev.target.value)}
                  style={{
                    appearance: "none", WebkitAppearance: "none",
                    paddingLeft: 10, paddingRight: 26, paddingTop: 5, paddingBottom: 5,
                    borderRadius: 10,
                    border: "1.5px solid #E0D8CF",
                    background: "#F5F1EB",
                    color: isCam ? "#7A1C3E" : "#00314B",
                    fontSize: 12,
                    fontWeight: 700,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    outline: "none",
                  }}
                >
                  <option value="newest">Newest</option>
                  <option value="oldest">Oldest</option>
                  <option value="amount">Highest $</option>
                  <option value="dueDate">Due Date</option>
                  <option value="unpaidFirst">Unpaid First</option>
                </select>
                <span style={{ position: "absolute", right: 8, pointerEvents: "none", display: "flex", alignItems: "center" }}>
                  <Icon path={icons.chevronDown} size={12} color={isCam ? "#7A1C3E" : "#00314B"} />
                </span>
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
        <div style={{ padding: "0 16px" }}>

          {/* ── Mandatory section — always pinned at top ── */}
          {!searchOpen && pinnedMandatoryGrouped.length > 0 && (
            <>
              {(() => {
                const mandatoryTotal = pinnedMandatoryGrouped.reduce((sum, item) => {
                  const items = item._isGroup ? item.items : [item];
                  return sum + items.reduce((s, e) => {
                    const share = e.split === "cam" ? Number(e.amount||0) : e.split === "split" ? Number(e.amount||0)/2 : e.split === "ella" ? -Number(e.amount||0) : Number(e.amount||0);
                    return s + (isCam ? Math.abs(share) : Number(e.amount||0));
                  }, 0);
                }, 0);
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 4px 10px" }}>
                    <div style={{ width: 10, height: 10, borderRadius: 3, background: "linear-gradient(135deg, #E05C6E, #C0485A)", flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 900, color: "#C0485A", textTransform: "uppercase", letterSpacing: 1 }}>Mandatory</span>
                    <div style={{ background: "#FFF0F2", border: "1px solid #F5C4CD", borderRadius: 20, padding: "2px 8px", fontSize: 11, fontWeight: 800, color: "#C0485A" }}>{pinnedMandatoryGrouped.length}</div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#C0485A", opacity: 0.7 }}>${mandatoryTotal.toFixed(2)}</span>
                    <div style={{ flex: 1, height: 1, background: "linear-gradient(to right, #F5C4CD, transparent)" }} />
                  </div>
                );
              })()}
              {pinnedMandatoryGrouped.map((item, i) => (
                <motion.div
                  key={item._isGroup ? `grp:${item.gid}` : item.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04, type: "spring", stiffness: 340, damping: 28 }}
                >
                  {item._isGroup ? (
                    <GroupExpenseRow gid={item.gid} items={item.items} user={user} targetSummaries={targetSummaries} onMarkPaid={onMarkPaid} onEdit={onEditExpense} onLogPaymentForKey={onLogPaymentForKey} />
                  ) : (
                    <ExpenseRow expense={item} user={user} onDelete={onDeleteExpense} onEdit={onEditExpense} onMarkPaid={onMarkPaid} targetSummaries={targetSummaries} payments={payments} onLogPaymentForKey={onLogPaymentForKey} onDispute={onDisputeExpense} />
                  )}
                </motion.div>
              ))}
            </>
          )}

          {/* ── Regular section ── */}
          {(searchOpen ? listToRender : regularGroupedList).length > 0 && (
            <>
              {!searchOpen && pinnedMandatoryGrouped.length > 0 && (() => {
                const regularTotal = regularGroupedList.reduce((sum, item) => {
                  const items = item._isGroup ? item.items : [item];
                  return sum + items.reduce((s, e) => {
                    const share = e.split === "cam" ? Number(e.amount||0) : e.split === "split" ? Number(e.amount||0)/2 : e.split === "ella" ? -Number(e.amount||0) : Number(e.amount||0);
                    return s + (isCam ? Math.abs(share) : Number(e.amount||0));
                  }, 0);
                }, 0);
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 4px 10px" }}>
                    <div style={{ width: 10, height: 10, borderRadius: 3, background: "linear-gradient(135deg, #00314B, #1B4D6B)", flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 900, color: "#00314B", textTransform: "uppercase", letterSpacing: 1 }}>Expenses</span>
                    <div style={{ background: "#E8F0F5", border: "1px solid #B8CDD8", borderRadius: 20, padding: "2px 8px", fontSize: 11, fontWeight: 800, color: "#00314B" }}>{regularGroupedList.length}</div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#00314B", opacity: 0.6 }}>${regularTotal.toFixed(2)}</span>
                    <div style={{ flex: 1, height: 1, background: "linear-gradient(to right, #B8CDD8, transparent)" }} />
                  </div>
                );
              })()}
              {(searchOpen ? listToRender : regularGroupedList).map((item, i) => (
                <motion.div
                  key={item._isGroup ? `grp:${item.gid}` : item.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: (pinnedMandatoryGrouped.length + i) * 0.04, type: "spring", stiffness: 340, damping: 28 }}
                >
                  {item._isGroup ? (
                    <GroupExpenseRow gid={item.gid} items={item.items} user={user} targetSummaries={targetSummaries} onMarkPaid={onMarkPaid} onEdit={onEditExpense} onLogPaymentForKey={onLogPaymentForKey} />
                  ) : (
                    <ExpenseRow expense={item} user={user} onDelete={onDeleteExpense} onEdit={onEditExpense} onMarkPaid={onMarkPaid} targetSummaries={targetSummaries} payments={payments} onLogPaymentForKey={onLogPaymentForKey} onDispute={onDisputeExpense} />
                  )}
                </motion.div>
              ))}
            </>
          )}

          {groupedList.length === 0 && !pinnedMandatoryGrouped.length && (
            <div style={{ padding: "48px 0", textAlign: "center", color: "#CCC", fontSize: 13, fontWeight: 600 }}>No expenses found</div>
          )}
        </div>
      )}

      {/* ── Total summary card (scrolls with content) ── */}
      {(() => {
        const footerList = searchOpen ? listToRender : [...pinnedMandatoryGrouped, ...regularGroupedList];
        const footerTotal = footerList.reduce((sum, item) => {
          const items = item._isGroup ? item.items : [item];
          return sum + items.reduce((s, e) => {
            const share = e.split === "cam" ? Number(e.amount||0) : e.split === "split" ? Number(e.amount||0)/2 : e.split === "ella" ? -Number(e.amount||0) : Number(e.amount||0);
            return s + (isCam ? Math.abs(share) : Number(e.amount||0));
          }, 0);
        }, 0);
        const footerCount = footerList.reduce((n, item) => n + (item._isGroup ? item.items.length : 1), 0);
        if (footerCount === 0) return null;
        const unpaidCount = (searchOpen ? listToRender : combinedFiltered).filter(e => e.status !== "paid").length;
        return (
          <div style={{
            margin: "12px 16px 0",
            background: isCam ? "linear-gradient(135deg, #00253A, #1A4D6B)" : "linear-gradient(135deg, #00314B, #1B5C80)",
            borderRadius: 20,
            padding: "14px 18px",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            boxShadow: "0 6px 20px rgba(0,0,0,0.15)",
          }}>
            <div>
              <p style={{ margin: 0, fontSize: 11, color: "rgba(255,255,255,0.5)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6 }}>
                {statusFilter === "all" ? "All" : statusFilter === "unpaid" ? "Unpaid" : statusFilter === "overdue" ? "Overdue" : statusFilter === "paid" ? "Paid" : "Plans"} · {footerCount} item{footerCount !== 1 ? "s" : ""}
              </p>
              <p style={{ margin: "2px 0 0", fontSize: 24, fontWeight: 900, color: "#fff", letterSpacing: -0.8, lineHeight: 1 }}>
                ${footerTotal.toFixed(2)}
              </p>
            </div>
            {unpaidCount > 0 && (
              <div style={{ textAlign: "right" }}>
                <p style={{ margin: 0, fontSize: 10, color: "rgba(255,255,255,0.45)", fontWeight: 600 }}>unpaid</p>
                <p style={{ margin: "2px 0 0", fontSize: 22, fontWeight: 900, color: "#FFB3B3", letterSpacing: -0.4, lineHeight: 1 }}>{unpaidCount}</p>
              </div>
            )}
          </div>
        );
      })()}

      <div style={{ height: 100 }} />

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
  const [expandedId, setExpandedId] = useState(null);
  const [filter, setFilter] = useState("all");
  const tabRef = useRef(null);
  const [pillStyle, setPillStyle] = useState({ left: 0, width: 0 });

  const tabs = [
    { id: "all",      label: "All" },
    { id: "payments", label: "Payments" },
    { id: "charges",  label: "Charges" },
    { id: "disputes", label: "Disputes" },
  ];

  useEffect(() => {
    if (!tabRef.current) return;
    const container = tabRef.current;
    const idx = tabs.findIndex(t => t.id === filter);
    const btn = container.children[idx + 1]; // +1 to skip the pill div
    if (!btn) return;
    const cRect = container.getBoundingClientRect();
    const bRect = btn.getBoundingClientRect();
    setPillStyle({ left: bRect.left - cRect.left, width: bRect.width });
  }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = [
    ...payments.map((p) => ({ ...p, _kind: "payment" })),
    ...expenses.flatMap((e) => {
      if (e.lastPaidAt) return [{ ...e, _kind: "expense", status: "paid", date: e.lastPaidAt, _paidEvent: true }];
      return [{ ...e, _kind: "expense" }];
    }),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  const filtered = all.filter((item) => {
    if (filter === "payments") return item._kind === "payment" && item.type !== "dispute";
    if (filter === "charges") return item._kind === "expense";
    if (filter === "disputes") return item._kind === "payment" && item.type === "dispute";
    return true;
  });

  const targetLabelByKey = new Map((targets || []).map((t) => [t.key, t.label]));

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

  const hRow = (label, value, mono = false, light = false) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
      <span style={{ fontSize: 12, color: light ? "#888" : "rgba(255,255,255,0.55)", fontWeight: 600, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: light ? "#1A1A2E" : "#fff", textAlign: "right", fontFamily: mono ? "monospace" : "inherit" }}>{value}</span>
    </div>
  );

  const splitLabel = (s) => s === "cam" ? "Cameron pays full" : s === "split" ? "Split 50/50" : s === "ella" ? "Emmanuella pays full" : s;

  return (
    <div style={{ ...styles.screen, background: "#F5F6FA" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", padding: "calc(env(safe-area-inset-top, 47px) + 16px) 16px 8px", background: "#F5F6FA" }}>
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          style={{ width: 36, height: 36, borderRadius: 12, border: "none", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: "0 1px 4px rgba(0,0,0,0.08)", flexShrink: 0 }}
        >
          <Icon path={icons.back} size={18} color="#1A1A2E" />
        </button>
        <h2 style={{ flex: 1, textAlign: "center", margin: 0, fontSize: 18, fontWeight: 800, color: "#1A1A2E", letterSpacing: -0.3 }}>My Transactions</h2>
        <div style={{ width: 36 }} />
      </div>

      {/* Sliding pill toggle */}
      <div style={{ padding: "10px 16px 14px" }}>
        <div
          ref={tabRef}
          style={{ position: "relative", display: "flex", background: "rgba(26,26,46,0.07)", borderRadius: 14, padding: 4 }}
        >
          {/* Sliding pill */}
          <div
            style={{
              position: "absolute",
              top: 4,
              height: "calc(100% - 8px)",
              left: pillStyle.width ? pillStyle.left : 4,
              width: pillStyle.width || "25%",
              background: "linear-gradient(135deg, #00314B, #1B4D6B)",
              borderRadius: 10,
              transition: "left 0.38s cubic-bezier(0.34,1.56,0.64,1), width 0.38s cubic-bezier(0.34,1.56,0.64,1)",
              boxShadow: "0 2px 8px rgba(0,49,75,0.22)",
              pointerEvents: "none",
            }}
          />
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => { setFilter(t.id); setExpandedId(null); }}
              style={{
                flex: 1,
                padding: "9px 4px",
                border: "none",
                background: "transparent",
                color: filter === t.id ? "#fff" : "#888",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                borderRadius: 10,
                position: "relative",
                zIndex: 1,
                transition: "color 0.25s ease",
                whiteSpace: "nowrap",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Activity Timeline */}
      {filtered.length === 0 && (
        <div style={{ padding: 48, textAlign: "center", color: "#CCC", fontSize: 13, fontWeight: 600 }}>No activity yet</div>
      )}
      {(() => {
        // Group items by date
        const groups = [];
        let lastDate = null;
        for (const item of filtered) {
          const d = (item.date || "").slice(0, 10);
          if (d !== lastDate) { groups.push({ date: d, items: [] }); lastDate = d; }
          groups[groups.length - 1].items.push(item);
        }
        function dateLabel(iso) {
          if (!iso) return "";
          const today = new Date(); today.setHours(0,0,0,0);
          const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
          const d = new Date(iso + "T12:00:00");
          if (d >= today) return "Today";
          if (d >= yesterday) return "Yesterday";
          return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined });
        }
        let globalIdx = 0;
        return groups.map((group, gi) => (
          <motion.div
            key={group.date}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: gi * 0.07, type: "spring", stiffness: 340, damping: 28 }}
            style={{ margin: "0 16px", marginBottom: gi === groups.length - 1 ? 0 : 4 }}
          >
            {/* Date header */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 0 10px" }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: "#888", background: "#E8E8EE", borderRadius: 20, padding: "3px 12px", whiteSpace: "nowrap", letterSpacing: 0.3 }}>{dateLabel(group.date)}</span>
              <div style={{ flex: 1, height: 1, background: "#EBEBF0" }} />
            </div>
            {/* Timeline items */}
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {group.items.map((item, ii) => {
                const rowId = item._kind === "payment" ? item.id : `exp-${item.id}`;
                const isOpen = expandedId === rowId;
                const isLastInGroup = ii === group.items.length - 1;
                const itemDelay = gi * 0.07 + ii * 0.05;

                if (item._kind === "payment") {
            const isConfirmed = item.confirmed;
            const isRejected = item.rejected && !item.confirmed;
            const isDispute = item.type === "dispute";
            const lbl = paymentTargetLabel(item);
            const rExp = relatedExpense(item);

            // Method-based icon colors
            const methodColors = { Zelle: { bg: "#F0EBF8", color: "#6B2FBF" }, "Cash App": { bg: "#E6FAF0", color: "#00A82A" }, Venmo: { bg: "#E6F2FB", color: "#3D95CE" }, "Apple Pay": { bg: "#F0F0F0", color: "#1A1A1A" }, Cash: { bg: "#EBF5E8", color: "#4A8040" } };
            const mc = methodColors[item.method] || { bg: "#FFF8E8", color: "#C8A020" };
            const iconBg = isDispute ? "#FFF0F4" : isRejected ? "#FFF0F0" : isConfirmed ? (methodColors[item.method]?.bg || "#E8F5EE") : mc.bg;
            const iconColor = isDispute ? "#C0485A" : isRejected ? "#E05C6E" : isConfirmed ? (methodColors[item.method]?.color || "#2D7A50") : mc.color;
            const iconPath = isDispute ? icons.flag : isRejected ? icons.x : isConfirmed ? icons.check : icons.clock;
            const amtColor = isDispute ? "#C0485A" : isConfirmed ? "#2D7A50" : isRejected ? "#E05C6E" : "#C8A020";
            const statusLabel = isDispute
              ? (item.resolution === "accepted" ? "resolved" : item.resolution === "denied" ? "declined" : "disputed")
              : isConfirmed ? "confirmed" : isRejected ? "returned" : "pending";

            return (
              <motion.div
                key={rowId}
                initial={{ opacity: 0, x: -14 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: itemDelay, type: "spring", stiffness: 340, damping: 28 }}
              >
                <div
                  role="button"
                  onClick={() => setExpandedId(isOpen ? null : rowId)}
                  style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", cursor: "pointer", borderBottom: isLastInGroup && !isOpen ? "none" : "1px solid #F2F2F5" }}
                >
                  <div style={{ width: 46, height: 46, borderRadius: 16, background: iconBg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: `0 2px 8px ${iconColor}22` }}>
                    <Icon path={iconPath} size={20} color={iconColor} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: "#1A1A2E", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {isDispute ? `Dispute — ${item.disputeDescription || "charge"}` : `${item.method} Payment`}
                    </p>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: amtColor, borderRadius: 6, padding: "1px 7px", textTransform: "capitalize" }}>{statusLabel}</span>
                      {lbl && <span style={{ fontSize: 11, color: "#BBB", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lbl}</span>}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    {!isDispute && (
                      <p style={{ margin: 0, fontSize: isConfirmed ? 20 : 16, fontWeight: 900, color: amtColor, letterSpacing: -0.5 }}>
                        {isConfirmed ? "+" : "−"}${Number(item.amount || 0).toFixed(2)}
                      </p>
                    )}
                    <p style={{ margin: isDispute ? 0 : "2px 0 0", fontSize: 11, color: "#BBB" }}>{formatHistoryDate(item.date)}</p>
                  </div>
                </div>

                <motion.div
                    initial={false}
                    animate={{ height: isOpen ? "auto" : 0, opacity: isOpen ? 1 : 0 }}
                    transition={{ type: "tween", duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
                    style={{ overflow: "hidden" }}
                  >
                  <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 10, borderBottom: isLastInGroup ? "none" : "1px solid #F2F2F5" }}>
                    <div style={{ background: isDispute ? "linear-gradient(145deg, #2A0810, #4A1020)" : isConfirmed ? "linear-gradient(145deg, #061A10, #0D3020)" : isRejected ? "linear-gradient(145deg, #2A0808, #4A1010)" : "linear-gradient(145deg, #1A1408, #2E2410)", borderRadius: 16, padding: 14, display: "flex", flexDirection: "column", gap: 9 }}>
                      {isDispute ? (
                        <>
                          {item.disputeDescription && hRow("Charge", item.disputeDescription)}
                          {item.disputeReason && (
                            <div style={{ paddingTop: item.disputeDescription ? 6 : 0, borderTop: item.disputeDescription ? "1px solid rgba(255,255,255,0.08)" : "none" }}>
                              <p style={{ margin: "0 0 3px", fontSize: 10, fontWeight: 800, color: "#FF8090", textTransform: "uppercase", letterSpacing: 0.5 }}>Reason</p>
                              <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.65)", lineHeight: 1.5 }}>"{item.disputeReason}"</p>
                            </div>
                          )}
                          {hRow("Date", formatHistoryDate(item.date))}
                          {hRow("Status", statusLabel.charAt(0).toUpperCase() + statusLabel.slice(1))}
                          {item.resolution === "denied" && item.declineReason && (
                            <div style={{ paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                              <p style={{ margin: "0 0 3px", fontSize: 10, fontWeight: 800, color: "#E07A20", textTransform: "uppercase", letterSpacing: 0.5 }}>Response</p>
                              <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.6)", fontStyle: "italic" }}>"{item.declineReason}"</p>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          {hRow("Amount", `$${Number(item.amount || 0).toFixed(2)}`)}
                          {hRow("Method", item.method)}
                          {hRow("Date", formatPaymentDateTime(item))}
                          {lbl && hRow("Applied to", lbl)}
                          {item.note && hRow("Note", `"${item.note}"`)}
                          {isRejected && item.rejectionReason && (
                            <div style={{ paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                              <p style={{ margin: "0 0 3px", fontSize: 10, fontWeight: 800, color: "#E07A20", textTransform: "uppercase", letterSpacing: 0.5 }}>Emmanuella's note</p>
                              <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.6)", fontStyle: "italic" }}>"{item.rejectionReason}"</p>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    {rExp && (
                      <div style={{ background: "rgba(255,255,255,0.07)", borderRadius: 14, padding: 14, display: "flex", flexDirection: "column", gap: 9 }}>
                        <p style={{ margin: "0 0 6px", fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: 0.5 }}>Related Expense</p>
                        {hRow(rExp.description, `$${Number(rExp.amount || 0).toFixed(2)}`)}
                        {rExp.split && hRow("Split", splitLabel(rExp.split))}
                        {rExp.status && hRow("Status", rExp.status === "paid" ? "Paid" : "Unpaid")}
                      </div>
                    )}
                    {user === "emma" && (
                      <div style={{ display: "flex", gap: 8 }}>
                        {!isConfirmed && !isRejected && (
                          <button
                            style={{ flex: 1, background: "linear-gradient(135deg, #A6B49E, #4E635E)", color: "#fff", border: "none", borderRadius: 12, padding: "12px 0", fontSize: 13, fontWeight: 800, cursor: "pointer" }}
                            onClick={() => { onConfirm(item.id); setExpandedId(null); }}
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
                </motion.div>
            </motion.div>
            );
          }

          // Expense row
          const expAmt = item.split === "split" ? item.amount / 2 : item.amount;
          const isPaid = item.status === "paid";

          return (
            <motion.div
              key={rowId}
              initial={{ opacity: 0, x: -14 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: itemDelay, type: "spring", stiffness: 340, damping: 28 }}
            >
              <div
                role="button"
                onClick={() => setExpandedId(isOpen ? null : rowId)}
                style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", cursor: "pointer", borderBottom: isLastInGroup && !isOpen ? "none" : "1px solid #F2F2F5" }}
              >
                <div style={{ width: 44, height: 44, borderRadius: 14, background: isPaid ? "#E8F5EE" : "#F0EEFF", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Icon path={isPaid ? icons.check : icons.chevronUp} size={20} color={isPaid ? "#2D7A50" : "#7B5EA7"} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#1A1A2E", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.description}
                  </p>
                  <p style={{ margin: "2px 0 0", fontSize: 12, color: "#AAA", fontWeight: 500 }}>
                    {item.category || (item.split === "split" ? "Split 50/50" : "Charge")}
                  </p>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: "#1A1A2E" }}>
                    −${Number(expAmt || 0).toFixed(2)}
                  </p>
                  <p style={{ margin: "2px 0 0", fontSize: 11, color: "#BBB" }}>{formatHistoryDate(item.date)}</p>
                </div>
              </div>

              <motion.div
                initial={false}
                animate={{ height: isOpen ? "auto" : 0, opacity: isOpen ? 1 : 0 }}
                transition={{ type: "tween", duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
                style={{ overflow: "hidden" }}
              >
                <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 10, borderBottom: isLastInGroup ? "none" : "1px solid #F2F2F5" }}>
                  <div style={{ background: "#F8F8FB", borderRadius: 14, padding: 14, display: "flex", flexDirection: "column", gap: 9 }}>
                    {hRow("Full amount", `$${Number(item.amount || 0).toFixed(2)}`, false, true)}
                    {item.split && hRow("Split", splitLabel(item.split), false, true)}
                    {item.category && hRow("Category", item.category, false, true)}
                    {item.account && hRow("Charged to", item.account, false, true)}
                    {item.recurring && item.recurring !== "none" && hRow("Recurring", item.recurring, false, true)}
                    {(item.dueDate || item.nextDue) && hRow("Due date", formatShortDate(item.dueDate || item.nextDue), false, true)}
                    {item.referenceNum && hRow("Ref #", item.referenceNum, true, true)}
                    {item.note && hRow("Note", `"${item.note}"`, false, true)}
                    {hRow("Status", isPaid ? "Paid ✓" : "Unpaid", false, true)}
                  </div>
                  {isPaid && user === "emma" && typeof onDeleteExpense === "function" && (
                    <button
                      style={{ background: "#FFF0F2", color: "#C0485A", border: "1.5px solid #F5C4CD", borderRadius: 12, padding: "12px 0", fontSize: 13, fontWeight: 700, cursor: "pointer", width: "100%" }}
                      onClick={() => onDeleteExpense(item.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </motion.div>
            </motion.div>
          );
              })}
            </div>
          </motion.div>
        ));
      })()}
      <div style={{ height: 80 }} />
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
    <motion.div layout style={{ ...fw.expenseCard, marginBottom: 10 }}>
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

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="grp-expand"
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            transition={{ type: "tween", duration: 0.32, ease: [0.25, 0.46, 0.45, 0.94] }}
            style={{ overflow: "hidden" }}
          >
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ delay: 0.06, duration: 0.24, ease: "easeOut" }}
              style={{ borderTop: "1px solid #EEE9E0", padding: "2px 14px 10px" }}
            >
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
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
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
        background: "#fff",
        borderRadius: 20,
        marginBottom: 10,
        overflow: "hidden",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 6px 20px rgba(0,0,0,0.04)",
        border: "1px solid rgba(0,0,0,0.05)",
        opacity: e._deleting ? 0.45 : e._marking ? 0.7 : 1,
        pointerEvents: e._deleting || e._marking ? "none" : "auto",
        position: "relative",
      }}
    >
      {/* Urgency accent bar */}
      <div style={{
        position: "absolute",
        left: 0, top: 0, bottom: 0,
        width: 6,
        borderRadius: "20px 0 0 20px",
        background: e.status === "paid"
          ? "linear-gradient(180deg, #A6B49E, #4E635E)"
          : urgency === "overdue"
            ? "linear-gradient(180deg, #E05C6E, #C0485A)"
            : urgency === "critical"
              ? "linear-gradient(180deg, #E07820, #C45C18)"
              : urgency === "warning"
                ? "linear-gradient(180deg, #E8C878, #C8A020)"
                : "linear-gradient(180deg, #D0D8E0, #B0BCC8)",
      }} />

      <div
        style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 14px 14px 20px", cursor: "pointer" }}
        onClick={() => { if (e._deleting || e._marking) return; setExpanded(o => !o); }}
        role="button"
      >
        {/* Category icon circle */}
        {(() => {
          const cat = (e.category || "").toLowerCase();
          const isRecurring = e.recurring && e.recurring !== "none";
          const circleStyle = cat.includes("grocer") || cat.includes("food") || cat.includes("instacart") || cat.includes("shipt")
            ? { bg: "#F0F7EA", color: "#4A8040" }
            : cat.includes("eating") || cat.includes("restaurant") || cat.includes("dining")
              ? { bg: "#FFF3EC", color: "#E07820" }
              : cat.includes("home") || cat.includes("rent") || cat.includes("electric") || cat.includes("utility")
                ? { bg: "#EBF0EE", color: "#4E635E" }
                : e.mandatory
                  ? { bg: "#FFF0F2", color: "#C0485A" }
                  : { bg: "#EEF4FA", color: "#7A9BB5" };
          const iconPath = isRecurring && e.mandatory
            ? icons.clock
            : cat.includes("grocer") || cat.includes("food") || cat.includes("instacart") || cat.includes("shipt")
              ? icons.check
              : cat.includes("eating") || cat.includes("restaurant")
                ? icons.clock
                : cat.includes("home") || cat.includes("rent") || cat.includes("electric") || cat.includes("utility")
                  ? icons.wallet
                  : e.mandatory
                    ? icons.alert
                    : icons.list;
          return (
            <div style={{ position: "relative", flexShrink: 0 }}>
              <div style={{
                width: 44, height: 44, borderRadius: 14,
                background: circleStyle.bg,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Icon path={iconPath} size={20} color={circleStyle.color} />
              </div>
              {isRecurring && (
                <div style={{
                  position: "absolute", bottom: -2, right: -2,
                  width: 16, height: 16, borderRadius: 6,
                  background: "#5B6EBD", border: "2px solid #fff",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 9, color: "#fff", fontWeight: 900, lineHeight: 1,
                }}>↺</div>
              )}
            </div>
          );
        })()}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: "0 0 2px", fontSize: 13, fontWeight: 600, color: "#9AA0B0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {isCam ? `${e.account || ""} · ${e.category || ""}` : `${formatShortDate(e.date)} · ${e.account || ""}`}
              </p>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: "#1A1A2E", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.description}
              </p>
            </div>
            <p style={{ margin: 0, fontSize: 22, fontWeight: 900, color: "#1A1A2E", flexShrink: 0, letterSpacing: -0.8, lineHeight: 1.1 }}>
              ${Number(isCam ? Math.abs(camShare) : Number(e.amount || 0)).toFixed(2)}
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", marginTop: 5, gap: 8 }}>
            <p style={{ margin: 0, fontSize: 12, color: "#9AA0B0", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {""}
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              {!isCam && camAmt !== 0 && (
                <span style={{ fontSize: 11, color: "#E8A0B0", fontWeight: 700 }}>Cam ${Number(camAmt || 0).toFixed(2)}</span>
              )}
              {isCam && (
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 3,
                  padding: "3px 9px", borderRadius: 999, fontSize: 10, fontWeight: 800,
                  background: camStatusLabel === "Paid" || camStatusLabel === "Credit" ? "#EBF0E8"
                    : camStatusLabel === "Overdue" ? "#FFF0F0" : "#FBEFF5",
                  color: camStatusLabel === "Paid" || camStatusLabel === "Credit" ? "#2D5A4A"
                    : camStatusLabel === "Overdue" ? "#E05C6E" : "#C06A8A",
                }}>
                  {camStatusLabel === "Overdue" && <Icon path={icons.alert} size={9} color="#E05C6E" />}
                  {camStatusLabel}
                </span>
              )}
              {!isCam && (
                <span style={{
                  display: "inline-flex", alignItems: "center",
                  padding: "3px 9px", borderRadius: 999, fontSize: 10, fontWeight: 800,
                  background: e.status === "paid" ? "#EBF0E8" : urgency === "overdue" ? "#FFF0F0" : urgency === "critical" ? "#FFF5EC" : "#F5F5F8",
                  color: e.status === "paid" ? "#2D5A4A" : urgency === "overdue" ? "#E05C6E" : urgency === "critical" ? "#E07820" : "#9AA0B0",
                }}>
                  {e.status === "paid" ? "Paid" : urgency === "overdue" ? "Overdue" : urgency === "critical" ? "Due Soon" : "Unpaid"}
                </span>
              )}
              <Icon
                path={expanded ? icons.chevronUp : icons.chevronDown}
                size={14}
                color={expanded ? "#00314B" : "#CCC"}
              />
            </div>
          </div>

          {isCam && (
            <div style={{ width: "100%", height: 3, borderRadius: 999, background: "#F3EDF8", marginTop: 8, overflow: "hidden" }}>
              <div style={{ width: e.status === "paid" ? "100%" : camIsCredit ? "100%" : "55%", height: "100%", background: camStatusColor, borderRadius: 999 }} />
            </div>
          )}

          {(() => {
            const due = e.nextDue || e.dueDate;
            const isRecurring = e.recurring && e.recurring !== "none";
            const isOverdue = getUrgencyLevel(e) === "overdue";
            const isPaid = e.status === "paid";
            const recurLabel = isRecurring
              ? ({ monthly: "Monthly", weekly: "Weekly", biweekly: "Every 2 wks", yearly: "Yearly", quarterly: "Quarterly" }[e.recurring] || e.recurring)
              : null;
            if (!due && !isRecurring) return null;
            return (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                {isRecurring && (
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 3,
                    fontSize: 10, fontWeight: 800,
                    background: "#F0F4FF", color: "#5B6EBD",
                    borderRadius: 6, padding: "2px 7px",
                  }}>
                    ↺ {recurLabel}
                  </span>
                )}
                {due && (
                  <span style={{
                    fontSize: 10, fontWeight: 700,
                    color: isOverdue ? "#E05C6E" : isPaid ? "#C0C0C8" : "#A6B7CB",
                  }}>
                    {isOverdue ? "⚠ Overdue · " : isPaid ? "Was due · " : "Next · "}{formatShortDate(due)}
                  </span>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      <AnimatePresence initial={false}>
      {expanded && (
        <motion.div
          key="expand"
          initial={{ height: 0 }}
          animate={{ height: "auto" }}
          exit={{ height: 0 }}
          transition={{ type: "tween", duration: 0.32, ease: [0.25, 0.46, 0.45, 0.94] }}
          style={{ overflow: "hidden" }}
        >
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ delay: 0.06, duration: 0.24, ease: "easeOut" }}
          style={fw.expandPanel}
          onClick={(ev) => ev.stopPropagation()}
        >
          

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

          {e.receiptUrl && (
            <div style={{ marginTop: 10, borderRadius: 12, overflow: "hidden", border: "1.5px solid #EDE7DC" }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#A6B7CB", textTransform: "uppercase", letterSpacing: 0.6, padding: "8px 10px 4px" }}>Receipt</div>
              <img src={e.receiptUrl} alt="Receipt" style={{ display: "block", width: "100%", maxHeight: 220, objectFit: "cover" }} />
            </div>
          )}

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
        </motion.div>
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
    receiptUrl: "",
  });
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const receiptInputRef = useRef(null);

  function handleReceiptFile(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    const canvas = document.createElement("canvas");
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 800;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
      set("receiptUrl", dataUrl);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }
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
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: showNotes ? "#EAF0EE" : "#F0EDE8", border: "none", borderRadius: 12, padding: "10px 13px", cursor: "pointer" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: showNotes ? "#4E635E" : "#D0C8BC", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                      <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                      <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
                    </svg>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: showNotes ? "#00314B" : "#888" }}>{showNotes ? "Hide details" : "Add note, ref # or receipt"}</span>
                </div>
                <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={showNotes ? "#4E635E" : "#BBB"} strokeWidth={2.5} strokeLinecap="round" style={{ transform: showNotes ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s", flexShrink: 0 }}>
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

                  {/* Receipt upload */}
                  <input
                    ref={receiptInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    style={{ display: "none" }}
                    onChange={handleReceiptFile}
                  />
                  {form.receiptUrl ? (
                    <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", border: "1.5px solid #DDD5C5" }}>
                      <img src={form.receiptUrl} alt="Receipt" style={{ display: "block", width: "100%", maxHeight: 180, objectFit: "cover" }} />
                      <button
                        type="button"
                        onClick={() => set("receiptUrl", "")}
                        style={{ position: "absolute", top: 6, right: 6, width: 26, height: 26, borderRadius: "50%", background: "rgba(0,0,0,0.55)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                      >
                        <Icon path={icons.x} size={13} color="#fff" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => receiptInputRef.current?.click()}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 12, border: "1.5px dashed #DDD5C5", background: "#F5F1EB", cursor: "pointer", width: "100%", boxSizing: "border-box" }}
                    >
                      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#A6B7CB" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/>
                        <circle cx="12" cy="13" r="4"/>
                      </svg>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#A6B7CB" }}>Attach receipt photo</span>
                    </button>
                  )}
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

            <div style={{ display: "flex", gap: 8 }}>
              {splitOptions.map(([val, label, color]) => {
                const isActive = form.split === val;
                return (
                  <button
                    key={val}
                    type="button"
                    onClick={() => set("split", val)}
                    style={{
                      flex: 1, padding: "10px 6px", borderRadius: 14, border: "none",
                      background: isActive ? color : "#EEE9E0",
                      color: isActive ? "#fff" : "#888",
                      fontSize: 12, fontWeight: 800, cursor: "pointer",
                      boxShadow: isActive ? `0 4px 12px ${color}55` : "none",
                      transition: "all 0.2s ease",
                      transform: isActive ? "scale(1.04)" : "scale(1)",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

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
              if (!data.receiptUrl) delete data.receiptUrl;
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
async function uploadProof(file) {
  const { ref, uploadBytes, getDownloadURL } = await import("firebase/storage");
  const { storage } = await import("./firebase");
  const path = `paymentProof/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g, "_")}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  return getDownloadURL(storageRef);
}

function LogPaymentModal({ balance, onSave, onClose, user, targets = [], planSummaries, targetSummaries, initialAppliedToKey, initialAmount }) {
  const [form, setForm] = useState({
    amount: initialAmount != null ? String(Number(initialAmount).toFixed(2)) : "",
    method: "Zelle",
    date: new Date().toISOString().split("T")[0],
    note: "",
    appliedToKey: initialAppliedToKey || "general",
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const [proofOpen, setProofOpen] = useState(false);
  const [proofFile, setProofFile] = useState(null);
  const [proofPreview, setProofPreview] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  function handleProofPick(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setProofFile(file);
    const reader = new FileReader();
    reader.onload = ev => setProofPreview(ev.target.result);
    reader.readAsDataURL(file);
  }

  async function handleSave(basePayload) {
    if (proofFile) {
      setUploading(true);
      try {
        const url = await uploadProof(proofFile);
        basePayload.proofUrl = url;
      } catch (err) {
        console.error("Proof upload failed:", err);
      }
      setUploading(false);
    }
    onSave(basePayload);
  }

  // Reusable proof toggle + picker UI
  function ProofSection() {
    return (
      <div style={{ marginTop: 16 }}>
        {/* Toggle row */}
        <button type="button" onClick={() => setProofOpen(o => !o)}
          style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: proofOpen ? "#EAF0EE" : "#F5F1EB", border: "none", borderRadius: 14, padding: "12px 14px", cursor: "pointer" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 10, background: proofOpen ? "#4E635E" : "#DDD5C5", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/>
                <circle cx="12" cy="13" r="4"/>
              </svg>
            </div>
            <div style={{ textAlign: "left" }}>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#00314B" }}>Add payment proof</p>
              <p style={{ margin: 0, fontSize: 11, color: "#AAA" }}>Optional — screenshot or photo</p>
            </div>
          </div>
          {/* pill toggle */}
          <div style={{ width: 44, height: 26, borderRadius: 13, background: proofOpen ? "#4E635E" : "#DDD5C5", position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
            <div style={{ position: "absolute", top: 3, left: proofOpen ? 21 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.2)", transition: "left 0.2s cubic-bezier(.34,1.56,.64,1)" }} />
          </div>
        </button>

        {/* Expandable picker */}
        <AnimatePresence>
          {proofOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
              style={{ overflow: "hidden" }}
            >
              <div style={{ paddingTop: 10 }}>
                <input ref={fileInputRef} type="file" accept="image/*" capture="environment"
                  style={{ display: "none" }} onChange={handleProofPick} />
                {proofPreview ? (
                  <div style={{ position: "relative" }}>
                    <img src={proofPreview} alt="proof" style={{ width: "100%", borderRadius: 14, maxHeight: 200, objectFit: "cover", display: "block" }} />
                    <button type="button" onClick={() => { setProofFile(null); setProofPreview(null); }}
                      style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,0.55)", border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, padding: "4px 10px", cursor: "pointer" }}>
                      Remove
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => fileInputRef.current?.click()}
                    style={{ width: "100%", padding: "20px", borderRadius: 14, border: "2px dashed #C5D5C0", background: "#F5F9F5", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="#A6B49E" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
                    </svg>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#4E635E" }}>Tap to choose photo</span>
                    <span style={{ fontSize: 11, color: "#AAA" }}>Screenshot, Zelle receipt, etc.</span>
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

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

          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 4 }}>
            {[["Zelle","#6B2FBF"],["Cash App","#00A82A"],["Venmo","#3D95CE"],["Cash","#4A8040"],["Apple Pay","#1A1A1A"]].map(([m, color]) => (
              <button key={m} style={{
                ...styles.splitOption,
                fontSize: 12, flexShrink: 0,
                background: form.method === m ? color : "#EEE9E0",
                color: form.method === m ? "#fff" : "#666",
                fontWeight: form.method === m ? 800 : 500,
                boxShadow: form.method === m ? `0 3px 10px ${color}44` : "none",
                transition: "all 0.18s ease",
              }} onClick={() => set("method", m)}>{m}</button>
            ))}
          </div>

          {user === "cam" && <p style={{...styles.formNote, marginTop: 16}}>⚠️ Emmanuella will confirm once she receives it</p>}

          <ProofSection />

          <button
            disabled={uploading}
            style={{ ...styles.saveBtn, background: uploading ? "#C5D5C0" : "linear-gradient(135deg, #A6B49E, #4E635E)", marginTop: 16 }}
            onClick={() => {
              const key = form.appliedToKey || "general";
              const legacyGroupId = key.startsWith("grp:") ? key.slice(4) : undefined;
              handleSave({
                ...form,
                amount: Number(initialAmount),
                appliedToKey: key,
                ...(legacyGroupId ? { appliedToGroupId: legacyGroupId } : {}),
              });
            }}
          >
            {uploading ? "Uploading…" : "Done"}
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
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 4 }}>
            {(targets.length ? targets : [{ key: "general", label: "General (not assigned)" }]).map((t) => {
              const summary = targetSummaries && t.key && t.key !== "general" ? targetSummaries.get(t.key) : null;
              const remaining = summary ? Math.max(0, Number(summary.remaining || 0)) : null;
              const charged = summary ? Math.max(0, Number(summary.charged || 0)) : null;
              const pct = charged && remaining != null ? Math.round(((charged - remaining) / charged) * 100) : null;
              const isSelected = form.appliedToKey === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => {
                    set("appliedToKey", t.key);
                    if (!form.amount && summary?.suggested != null) {
                      const s = Math.max(0, Number(summary.suggested || 0));
                      const cap = Math.max(0, Math.abs(Number(summary.remaining || 0)));
                      set("amount", String(Number(Math.min(s, cap)).toFixed(2)));
                    }
                  }}
                  style={{
                    width: "100%", textAlign: "left", border: "none", cursor: "pointer", borderRadius: 14,
                    background: isSelected ? "linear-gradient(135deg, #00314B, #1B5C80)" : "#F5F1EB",
                    padding: "12px 14px",
                    boxShadow: isSelected ? "0 4px 14px rgba(0,49,75,0.25)" : "none",
                    transition: "all 0.18s ease",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: isSelected ? "#fff" : "#00314B" }}>{t.label}</span>
                    {remaining != null && (
                      <span style={{ fontSize: 13, fontWeight: 900, color: isSelected ? "#A8EFC4" : "#E05C6E" }}>${remaining.toFixed(2)}</span>
                    )}
                  </div>
                  {pct != null && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ background: isSelected ? "rgba(255,255,255,0.15)" : "#E8E0D5", borderRadius: 4, height: 4, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: isSelected ? "#A8EFC4" : "#A6B49E", borderRadius: 4, transition: "width 0.4s" }} />
                      </div>
                      <span style={{ fontSize: 10, color: isSelected ? "rgba(255,255,255,0.5)" : "#AAA", fontWeight: 600, marginTop: 3, display: "block" }}>{pct}% paid</span>
                    </div>
                  )}
                  {t.key === "general" && !summary && (
                    <span style={{ fontSize: 11, color: isSelected ? "rgba(255,255,255,0.5)" : "#BBB", fontWeight: 500 }}>Not tied to a specific expense</span>
                  )}
                </button>
              );
            })}
          </div>

          <label style={styles.label}>How did you pay?</label>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            {[["Zelle","#6B2FBF"],["Cash App","#00A82A"],["Venmo","#3D95CE"],["Cash","#4A8040"],["Apple Pay","#1A1A1A"]].map(([m, color]) => (
              <button key={m} style={{
                ...styles.splitOption,
                fontSize: 12, flexShrink: 0,
                background: form.method === m ? color : "#EEE9E0",
                color: form.method === m ? "#fff" : "#666",
                fontWeight: form.method === m ? 800 : 500,
                boxShadow: form.method === m ? `0 3px 10px ${color}44` : "none",
                transition: "all 0.18s ease",
              }} onClick={() => set("method", m)}>{m}</button>
            ))}
          </div>

          <label style={styles.label}>Date</label>
          <input style={styles.input} type="date" value={form.date} onChange={e => set("date", e.target.value)} />

          <label style={styles.label}>Note (optional)</label>
          <input style={styles.input} placeholder="e.g. for the groceries" value={form.note} onChange={e => set("note", e.target.value)} />

          {user === "cam" && <p style={styles.formNote}>⚠️ Emmanuella will confirm once she receives it</p>}

          <ProofSection />

          <button
            disabled={uploading || !form.amount}
            style={{...styles.saveBtn, background: (uploading || !form.amount) ? "#C5D5C0" : "linear-gradient(135deg, #A6B49E, #4E635E)", marginTop: 8 }}
            onClick={() => {
              if (!form.amount) return;
              const key = form.appliedToKey || "general";
              const legacyGroupId = key.startsWith("grp:") ? key.slice(4) : undefined;
              handleSave({
                ...form,
                amount: parseFloat(form.amount),
                appliedToKey: key,
                ...(legacyGroupId ? { appliedToGroupId: legacyGroupId } : {}),
              });
            }}>
            {uploading ? "Uploading…" : "Submit Payment"}
          </button>
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
  const btnRefs = useRef([]);
  const [navPill, setNavPill] = useState({ left: 0, top: 0, width: 0, height: 0 });

  useEffect(() => {
    const container = navRef.current;
    const idx = tabs.findIndex(t => t.id === screen);
    const btn = btnRefs.current[idx];
    if (!container || !btn) return;
    const nr = container.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const hPad = 10;
    const vPad = 5;
    setNavPill({
      left: br.left - nr.left - hPad,
      top: br.top - nr.top - vPad,
      width: br.width + hPad * 2,
      height: br.height + vPad * 2,
    });
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  if (hidden) return null;
  return (
    <div ref={navRef} style={{ ...styles.bottomNav, position: "fixed", overflow: "visible" }}>
      <div className="lg-nav-pill" style={{ left: navPill.left, top: navPill.top, width: navPill.width, height: navPill.height }} />
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={el => btnRefs.current[i] = el}
          className="lg-btn"
          style={{ ...styles.navBtn, position: "relative", zIndex: 1 }}
          onClick={() => onNavigate(t.id)}
        >
          <div
            style={{ position: "relative", transition: "transform 0.3s cubic-bezier(.34,1.56,.64,1)", transform: screen === t.id ? "scale(1.1) translateY(-1px)" : "scale(1)" }}
          >
            <Icon
              path={t.icon}
              size={20}
              color={
                screen === t.id
                  ? "#C5D9BB"
                  : t.id === "urgent" && urgentCount > 0
                  ? "#E05C6E"
                  : "rgba(255,255,255,0.35)"
              }
            />
            {t.id === "urgent" && urgentCount > 0 && (
              <span style={{ position: "absolute", top: -4, right: -6, background: "#E05C6E", color: "#fff", borderRadius: 10, fontSize: 9, fontWeight: 800, padding: "1px 5px", minWidth: 14, textAlign: "center" }}>
                {urgentCount}
              </span>
            )}
          </div>
          <span style={{ fontSize: 10, transition: "color 0.22s ease, font-weight 0.22s ease", color: screen === t.id ? "#C5D9BB" : t.id === "urgent" && urgentCount > 0 ? "#E05C6E" : "rgba(255,255,255,0.3)", fontWeight: screen === t.id ? 700 : 400 }}>
            {t.label}
          </span>
        </button>
      ))}
    </div>
  );
}

// ── FRAMEWORK STYLES ─────────────────────────────────────────────────
const fw = {
  expenseCard: { background: "#fff", borderRadius: 20, marginBottom: 10, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 6px 20px rgba(0,0,0,0.04)", border: "1px solid rgba(0,0,0,0.05)" },
  expenseTop: { display: "flex", alignItems: "center", gap: 12, padding: "14px 14px 14px 18px", cursor: "pointer" },
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
  app: { maxWidth: 430, margin: "0 auto", minHeight: "100%", background: "linear-gradient(170deg, #EAF0F6 0%, #F5F1EB 55%, #EDE8E0 100%)", position: "relative", fontFamily: "'DM Sans', system-ui, sans-serif", paddingTop: "env(safe-area-inset-top)" },
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
    padding: "calc(env(safe-area-inset-top, 47px) + 10px) 16px 10px",
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
  header: { background: "rgba(255,255,255,0.72)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)", padding: "calc(env(safe-area-inset-top, 47px) + 16px) 20px 14px", borderBottom: "1px solid rgba(0,0,0,0.06)", boxShadow: "0 1px 12px rgba(0,49,75,0.06)" },
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
  headerGreet: { fontSize: 30, fontWeight: 900, color: "#00314B", margin: 0, letterSpacing: -0.8, lineHeight: 1.1 },
  headerSub: { fontSize: 11, color: "#A6B7CB", margin: "0 0 6px", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8 },
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
  urgentBanner: { margin: "16px 16px 0", background: "linear-gradient(135deg, #FFF0F0, #FFF5EC)", borderRadius: 16, padding: "16px 18px", border: "1.5px solid #E8A0B0", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", boxShadow: "0 4px 16px rgba(224,92,110,0.12)" },
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
  subHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "calc(env(safe-area-inset-top, 47px) + 16px) 16px 16px" },
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
  bottomNav: { position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 430, background: "rgba(10,18,14,0.88)", backdropFilter: "blur(24px) saturate(180%)", WebkitBackdropFilter: "blur(24px) saturate(180%)", borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", padding: "8px 0 max(20px, env(safe-area-inset-bottom))", boxShadow: "0 -2px 32px rgba(0,0,0,0.3)", zIndex: 200 },
  navBtn: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, background: "none", border: "none", cursor: "pointer", padding: "6px 0" },
  navBtnActive: {},

  notification: { position: "fixed", top: "calc(env(safe-area-inset-top, 47px) + 12px)", left: "50%", transform: "translateX(-50%)", padding: "12px 24px", borderRadius: 16, fontSize: 14, fontWeight: 700, zIndex: 999, boxShadow: "0 4px 20px rgba(0,0,0,0.15)", whiteSpace: "nowrap" },
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
          <Icon path={icons.back} size={18} color="#00314B" />
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