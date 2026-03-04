import { useState, useEffect, useRef } from "react";
import { onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut, setPersistence, browserLocalPersistence } from "firebase/auth";
import { listenExpenses, listenPayments, addExpense, addPayment, confirmPayment as confirmPaymentInDb, deleteExpense as deleteExpenseInDb, deletePayment as deletePaymentInDb, updateExpense as updateExpenseInDb } from "./data";
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


// ── CALCULATIONS ──────────────────────────────────────────────────────
function calcOwed(expenses) {
  return expenses
    .filter(e => e.status !== "paid")
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
  if (!e?.dueDate || e.status === "paid") return null;
  if (!["cam", "split"].includes(e.split)) return null;
  const days = getDaysUntilDue(e.dueDate);
  if (days === null) return null;
  if (days < 0) return "overdue";
  if (days <= 3) return "critical";
  if (days <= 7) return "warning";
  return null;
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
  const [expenses, setExpenses] = useState([]);
  const [payments, setPayments] = useState([]);
  const [notification, setNotification] = useState(null);
  const [modal, setModal] = useState(null); // "addExpense" | "logPayment" | "confirmPayment"
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

  const totalOwed = calcOwed(expenses);
  const totalPaid = calcPaid(payments);
  const balance = totalOwed - totalPaid;

  const urgentExpenses = expenses.filter((e) => getUrgencyLevel(e) !== null);
  const urgentCount = urgentExpenses.length;

  const syncingPayments = payments.some((p) => p && p._optimistic);

  function notify(msg, type = "success") {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 3000);
  }

  async function handleAddExpense(data) {
    const tempId = `tmp-exp-${Date.now()}`;
    const exp = { ...data, status: "unpaid" };

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
      notify("Couldn’t save expense. Check Firestore rules.", "error");
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
      notify("Couldn’t save payment. Check Firestore rules.", "error");
    }
  }

  async function handleConfirm(id) {
    try {
      await confirmPaymentInDb(id);
      notify("Payment confirmed! ✓");
    } catch (err) {
      console.error("Failed to confirm payment:", err);
      notify("Couldn’t confirm payment. Check Firestore rules.", "error");
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
      notify("Couldn’t delete payment. Check Firestore rules.", "error");
    }
  }

  async function handleMarkPaid(id) {
    if (user !== "emma") return;

    const ok = window.confirm("Mark this expense as paid?");
    if (!ok) return;

    // Optimistic UI
    const prevItem = expenses.find((e) => e.id === id) || null;
    const paidAt = new Date().toISOString();
    setExpenses((prev) => prev.map((e) => (e.id === id ? { ...e, status: "paid", paidAt } : e)));

    try {
      await updateExpenseInDb(id, { status: "paid", paidAt });
      notify("Marked as paid.");
    } catch (err) {
      console.error("Failed to mark paid:", err);
      // Roll back
      if (prevItem) setExpenses((prev) => prev.map((e) => (e.id === id ? prevItem : e)));
      notify("Couldn’t mark as paid. Check Firestore rules.", "error");
    }
  }


  async function handleDeleteExpense(id) {
  if (user !== "emma") return;

  const ok = window.confirm("Delete this expense? This cannot be undone.");
  if (!ok) return;

  // Optimistic UI: remove immediately
  const removed = expenses.find((e) => e.id === id) || null;
  setExpenses((prev) => prev.filter((e) => e.id !== id));

  try {
    await deleteExpenseInDb(id);
    notify("Expense deleted.");
    // Firestore listener will keep things synced.
  } catch (err) {
    console.error("Failed to delete expense:", err);
    // Roll back if it fails
    if (removed) setExpenses((prev) => [removed, ...prev]);
    notify("Couldn’t delete expense. Check Firestore rules.", "error");
  }
}

  if (!firebaseUser) return <LoginScreen />;

  return (
    <div style={styles.app}>
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
        <LogPaymentModal balance={balance} onSave={handleLogPayment} onClose={() => setModal(null)} user={user} />
      )}

      {/* Screen */}
      {screen === "dashboard" && (
        <DashboardScreen
          user={user}
          balance={balance}
          totalOwed={totalOwed}
          totalPaid={totalPaid}
          expenses={expenses}
          payments={payments}
          syncingPayments={syncingPayments}
          urgentCount={urgentCount}
          onAddExpense={() => setModal("addExpense")}
          onLogPayment={() => setModal("logPayment")}
          onConfirm={handleConfirm}
          onDeleteExpense={handleDeleteExpense}
          onNavigate={setScreen}
          onLogout={async () => { await signOut(auth); setScreen("dashboard"); }}
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
        />
      )}
      {screen === "expenses" && (
        <ExpensesScreen
          expenses={expenses}
          user={user}
          onBack={() => setScreen("dashboard")}
          onAddExpense={() => setModal("addExpense")}
          onDeleteExpense={handleDeleteExpense}
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

// ── DASHBOARD ─────────────────────────────────────────────────────────
function DashboardScreen({ user, balance, totalOwed, totalPaid, expenses, payments, syncingPayments, urgentCount, onAddExpense, onLogPayment, onConfirm, onDeleteExpense, onNavigate, onLogout }) {
  const pending = payments.filter(p => !p.confirmed);
  const recentExpenses = expenses.slice(0, 4);

  return (
    <div style={styles.screen}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <p style={styles.headerGreet}>Hey {user === "emma" ? "Emmanuella" : "Cameron"} 👋</p>
          <p style={styles.headerSub}>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
        </div>
        <button style={styles.logoutBtn} onClick={onLogout}>Switch</button>
      </div>

      {/* Balance Card */}
      <div style={styles.balanceCard}>
        <p style={styles.balanceLabel}>{user === "cam" ? "You owe Emmanuella" : "Cameron owes you"}</p>
        <p style={styles.balanceAmount}>${balance.toFixed(2)}</p>
        <div style={styles.balanceRow}>
          <div style={styles.balanceStat}>
            <span style={styles.balanceStatLabel}>Total charged</span>
            <span style={styles.balanceStatVal}>${totalOwed.toFixed(2)}</span>
          </div>
          <div style={styles.balanceDivider} />
          <div style={styles.balanceStat}>
            <span style={styles.balanceStatLabel}>Total paid</span>
            <span style={{ ...styles.balanceStatVal, color: "#A8EFC4" }}>
              ${totalPaid.toFixed(2)}
            </span>
          </div>
        </div>
      </div>
      {/* Urgent banner */}
{urgentCount > 0 && (
  <div
    style={styles.urgentBanner}
    onClick={() => onNavigate("urgent")}
    role="button"
  >
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ fontSize: 22 }}>🔥</span>
      <div>
        <p style={styles.urgentBannerTitle}>
          {urgentCount} payment{urgentCount === 1 ? "" : "s"} due soon
        </p>
        <p style={styles.urgentBannerSub}>Tap to see what needs attention</p>
      </div>
    </div>
    <span style={{ color: "#E05C6E", fontSize: 22, fontWeight: 700 }}>›</span>
  </div>
)}

      {/* Pending Confirmations (Emma only) */}
      {user === "emma" && pending.length > 0 && (
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
      {user === "cam" && pending.length > 0 && (
        <div style={{...styles.alertBox, background: "#FBF5E0", borderColor: "#E8C878"}}>
          <Icon path={icons.clock} size={16} color="#C8A020" />
          <p style={{color: "#7A5A10", fontSize: 13, margin: 0}}>
            ${pending.reduce((s,p) => s+p.amount, 0).toFixed(2)} payment pending Emmanuella's confirmation
          </p>
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


      {/* Recent Expenses */}
      <div style={styles.section}>
        <div style={{...styles.sectionHeader, justifyContent: "space-between"}}>
          <span style={styles.sectionTitle}>Recent charges</span>
          <button style={styles.seeAll} onClick={() => onNavigate("expenses")}>See all</button>
        </div>
        {recentExpenses.map(e => (
          <ExpenseRow key={e.id} expense={e} user={user} onDelete={onDeleteExpense} />
        ))}
      </div>

      <div style={{height: 80}} />
    </div>
  );
}

// ── URGENT SCREEN ────────────────────────────────────────────────────
function UrgentScreen({ expenses, user, onBack, onMarkPaid }) {
  const sorted = [...expenses].sort(
    (a, b) => (getDaysUntilDue(a.dueDate) ?? 999) - (getDaysUntilDue(b.dueDate) ?? 999)
  );

  return (
    <div style={styles.screen}>
      <div style={styles.subHeader}>
        <button style={styles.backBtn} onClick={onBack}>
          <Icon path={icons.back} size={20} />
        </button>
        <h2 style={styles.subTitle}>🔥 Urgent</h2>
        <div style={{ width: 36 }} />
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
            const days = getDaysUntilDue(e.dueDate);

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
                      Due: {e.dueDate}
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
                    {user === "emma" && (
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

// ── EXPENSES SCREEN ───────────────────────────────────────────────────
function ExpensesScreen({ expenses, user, onBack, onAddExpense, onDeleteExpense }) {
  const [filter, setFilter] = useState("all");
  const filtered = filter === "all" ? expenses : expenses.filter(e => e.split === filter);

  return (
    <div style={styles.screen}>
      <div style={styles.subHeader}>
        <button style={styles.backBtn} onClick={onBack}><Icon path={icons.back} size={20} /></button>
        <h2 style={styles.subTitle}>All Expenses</h2>
        <button style={styles.addSmall} onClick={onAddExpense}><Icon path={icons.plus} size={18} color="#fff" /></button>
      </div>

      {/* Filter tabs */}
      <div style={styles.filterRow}>
        {[["all","All"],["cam","Cam's"],["split","Split"],["mine","Mine"]].map(([val, label]) => (
          <button key={val} style={{...styles.filterTab, ...(filter === val ? styles.filterTabActive : {})}} onClick={() => setFilter(val)}>
            {label}
          </button>
        ))}
      </div>

      {filtered.map(e => (
        <ExpenseRow key={e.id} expense={e} detailed user={user} onDelete={onDeleteExpense} />
      ))}
      <div style={{height: 80}} />
    </div>
  );
}

// ── HISTORY SCREEN ────────────────────────────────────────────────────
function HistoryScreen({ expenses, payments, user, onBack, onConfirm, onDeleteConfirmedPayment }) {
  const all = [
    ...payments.map(p => ({ ...p, type: "payment" })),
    ...expenses.map(e => ({ ...e, type: "expense" })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  return (
    <div style={styles.screen}>
      <div style={styles.subHeader}>
        <button style={styles.backBtn} onClick={onBack}><Icon path={icons.back} size={20} /></button>
        <h2 style={styles.subTitle}>History</h2>
        <div style={{width: 36}} />
      </div>

      {all.map((item, i) => (
        <div key={i} style={styles.historyItem}>
          <div style={{
            ...styles.historyIcon,
            background: item.type === "payment" ? "#EEF5EC" : "#EDE4F5"
          }}>
            {item.type === "payment" ? "💳" : "🧾"}
          </div>
          <div style={styles.historyInfo}>
            <p style={styles.historyDesc}>
              {item.type === "payment" ? `Payment via ${item.method}` : item.description}
            </p>
            <p style={styles.historyMeta}>
              {item.date} {item.type === "payment" && !item.confirmed && <span style={styles.pendingBadge}>pending</span>}
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
            {item.type === "payment" && item.confirmed && user === "emma" && (
              <button
                style={styles.deleteBtn}
                onClick={() => onDeleteConfirmedPayment(item.id)}
                title="Delete confirmed payment"
              >
                <Icon path={icons.x} size={16} color="#E8A0B0" />
              </button>
            )}
          </div>
        </div>
      ))}
      <div style={{height: 80}} />
    </div>
  );
}


// ── EXPENSE ROW ───────────────────────────────────────────────────────
function ExpenseRow({ expense: e, detailed, user, onDelete }) {
  const camAmt =
  e.split === "cam" ? e.amount :
  e.split === "split" ? e.amount / 2 :
  e.split === "ella" ? -e.amount :
  0;
  return (
    <div style={styles.expenseRow}>
      <div style={{...styles.splitDot, background: SPLIT_COLORS[e.split]}} />
      <div style={styles.expenseInfo}>
        <p style={styles.expenseDesc}>{e.description}</p>
        <p style={styles.expenseMeta}>
          {e.date} · {e.account}
          {detailed && <span style={{...styles.splitBadge, background: SPLIT_COLORS[e.split] + "33", color: "#555"}}> {SPLIT_LABELS[e.split]}</span>}
        </p>
      </div>
      <div style={styles.expenseAmts}>
        <p style={styles.expenseTotal}>${e.amount.toFixed(2)}</p>
        {camAmt !== 0 && <p style={styles.expenseCam}>Cam: ${camAmt.toFixed(2)}</p>}
        {user === "emma" && typeof onDelete === "function" && (
          <button
            style={styles.deleteBtn}
            onClick={() => onDelete(e.id)}
            title="Delete"
          >
            <Icon path={icons.x} size={16} color="#E8A0B0" />
          </button>
        )}
      </div>
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
  account: "Navy Platinum",
  category: "Groceries"
});
  const set = (k, v) => setForm(f => ({...f, [k]: v}));

  return (
    <div style={styles.modalOverlay}>
      <div style={styles.modal}>
        <div style={styles.modalHeader}>
          <h3 style={styles.modalTitle}>Add Expense</h3>
          <button style={styles.closeBtn} onClick={onClose}><Icon path={icons.x} size={18} /></button>
        </div>
        <div style={styles.form}>
          <label style={styles.label}>Description</label>
          <input style={styles.input} placeholder="e.g. Groceries — Wegmans" value={form.description} onChange={e => set("description", e.target.value)} />

          <label style={styles.label}>Amount ($)</label>
          <input style={styles.input} type="number" placeholder="0.00" value={form.amount} onChange={e => set("amount", e.target.value)} />

          <label style={styles.label}>Who pays?</label>
          <div style={styles.splitRow}>
            {(
              user === "cam"
                ? [["cam","I pay","#E8A0B0"],["ella","Emmanuella pays","#7BBFB0"],["split","Split 50/50","#C4A8D4"]]
                : [["mine","I pay","#7BBFB0"],["cam","Cam pays","#E8A0B0"],["split","Split 50/50","#C4A8D4"]]
            ).map(([val, label, color]) => (
              <button key={val} style={{
                ...styles.splitOption,
                background: form.split === val ? color : "#F5F0FB",
                color: form.split === val ? "#fff" : "#666",
                fontWeight: form.split === val ? 700 : 400,
              }} onClick={() => set("split", val)}>{label}</button>
            ))}
          </div>

          <label style={styles.label}>Date</label>
          <input style={styles.input} type="date" value={form.date} onChange={e => set("date", e.target.value)} />

          <label style={styles.label}>
            Due Date <span style={{ color: "#BBB", fontWeight: 400, textTransform: "none", fontSize: 11 }}>(optional)</span>
          </label>
          <input
            style={styles.input}
            type="date"
            value={form.dueDate}
            onChange={(e) => set("dueDate", e.target.value)}
          />

          <label style={styles.label}>Category</label>
          <select style={styles.input} value={form.category} onChange={e => set("category", e.target.value)}>
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>

          <label style={styles.label}>Account</label>
          <select style={styles.input} value={form.account} onChange={e => set("account", e.target.value)}>
            {["Navy Platinum","Best Buy Visa","Klarna","Affirm","Cash","Zelle"].map(a => <option key={a}>{a}</option>)}
          </select>

          <button style={styles.saveBtn} onClick={() => {
            if (!form.description || !form.amount) return;
            const data = { ...form, amount: parseFloat(form.amount) };
            if (!data.dueDate) delete data.dueDate;
            onSave(data);
          }}>Save Expense</button>
        </div>
      </div>
    </div>
  );
}

// ── LOG PAYMENT MODAL ─────────────────────────────────────────────────
function LogPaymentModal({ balance, onSave, onClose, user }) {
  const [form, setForm] = useState({
    amount: "", method: "Zelle", date: new Date().toISOString().split("T")[0], note: ""
  });
  const set = (k, v) => setForm(f => ({...f, [k]: v}));

  return (
    <div style={styles.modalOverlay}>
      <div style={styles.modal}>
        <div style={styles.modalHeader}>
          <h3 style={styles.modalTitle}>Log Payment</h3>
          <button style={styles.closeBtn} onClick={onClose}><Icon path={icons.x} size={18} /></button>
        </div>
        {user === "cam" && (
          <div style={{...styles.alertBox, margin: "0 0 16px", background: "#FBF5E0", borderColor: "#E8C878"}}>
            <p style={{color: "#7A5A10", fontSize: 13, margin: 0}}>
              Current balance: <strong>${balance.toFixed(2)}</strong>
            </p>
          </div>
        )}
        <div style={styles.form}>
          <label style={styles.label}>Amount ($)</label>
          <input style={styles.input} type="number" placeholder="0.00" value={form.amount} onChange={e => set("amount", e.target.value)} />

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
            onSave({...form, amount: parseFloat(form.amount)});
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

// ── STYLES ────────────────────────────────────────────────────────────
const styles = {
  app: { maxWidth: 430, margin: "0 auto", minHeight: "100vh", background: "#F8F4FF", position: "relative", fontFamily: "'DM Sans', system-ui, sans-serif" },
  screen: { padding: "0 0 20px", overflowY: "auto", maxHeight: "100vh" },

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
  deleteBtn: { background: "transparent", border: "none", padding: 0, marginTop: 6, cursor: "pointer" },
  splitBadge: { borderRadius: 6, padding: "1px 6px", marginLeft: 4, fontSize: 10 },

  // Sub screens
  subHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "52px 16px 16px" },
  subTitle: { fontSize: 20, fontWeight: 800, color: "#2D1B5E", margin: 0 },
  backBtn: { background: "#fff", border: "none", borderRadius: 12, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.08)" },
  addSmall: { background: "#7BBFB0", border: "none", borderRadius: 12, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },

  filterRow: { display: "flex", gap: 8, padding: "0 16px 16px", overflowX: "auto" },
  filterTab: { flexShrink: 0, padding: "6px 16px", borderRadius: 20, border: "1px solid #E5DFF5", background: "#fff", fontSize: 13, color: "#888", cursor: "pointer" },
  filterTabActive: { background: "#2D1B5E", color: "#fff", borderColor: "#2D1B5E", fontWeight: 700 },

  // History
  historyItem: { display: "flex", gap: 12, padding: "12px 16px", borderBottom: "1px solid #F0EAF8", alignItems: "flex-start" },
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

  // Modal
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" },
  modal: { background: "#fff", borderRadius: "24px 24px 0 0", padding: "24px 20px 40px", width: "100%", maxWidth: 430, maxHeight: "90vh", overflowY: "auto" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  modalTitle: { fontSize: 20, fontWeight: 800, color: "#2D1B5E", margin: 0 },
  closeBtn: { background: "#F5F0FB", border: "none", borderRadius: 10, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },

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