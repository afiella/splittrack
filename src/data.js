import {
  collection,
  addDoc,
  doc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "./firebase";

const expensesCol = collection(db, "expenses");
const paymentsCol = collection(db, "payments");

// Listen (real-time)
export function listenExpenses(setExpenses) {
  const q = query(expensesCol, orderBy("date", "desc"));
  return onSnapshot(q, (snap) => {
    setExpenses(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export function listenPayments(setPayments) {
  const q = query(paymentsCol, orderBy("date", "desc"));
  return onSnapshot(q, (snap) => {
    setPayments(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

// Write
export async function addExpense(exp) {
  await addDoc(expensesCol, { ...exp, createdAt: serverTimestamp() });
}

export async function addPayment(pmt) {
  await addDoc(paymentsCol, { ...pmt, createdAt: serverTimestamp() });
}

export async function confirmPayment(id) {
  await updateDoc(doc(db, "payments", id), {
    confirmed: true,
    confirmedAt: serverTimestamp(),
  });
}

export async function deleteExpense(id) {
  await deleteDoc(doc(db, "expenses", id));
}

export async function deletePayment(id) {
  await deleteDoc(doc(db, "payments", id));
}

export async function rejectPayment(id, reason, suggestionKey) {
  const update = { rejected: true, rejectedAt: serverTimestamp() };
  if (reason) update.rejectionReason = reason;
  if (suggestionKey) update.rejectionSuggestionKey = suggestionKey;
  await updateDoc(doc(db, "payments", id), update);
}

export async function resolveDispute(id, resolution, declineReason) {
  // resolution: "accepted" | "denied"
  const update = { confirmed: true, disputeStatus: resolution, resolvedAt: serverTimestamp() };
  if (declineReason) update.declineReason = declineReason;
  await updateDoc(doc(db, "payments", id), update);
}

async function updateExpense(id, updates) {
  await updateDoc(doc(db, "expenses", id), updates);
}

export { updateExpense };

// Device token (FCM) — stored at deviceTokens/{userId}
export async function saveDeviceToken(userId, token) {
  await updateDoc(doc(db, "deviceTokens", userId), { fcmToken: token, updatedAt: serverTimestamp() })
    .catch(async () => {
      // Document might not exist yet — use setDoc
      const { setDoc } = await import("firebase/firestore");
      await setDoc(doc(db, "deviceTokens", userId), { fcmToken: token, updatedAt: serverTimestamp() });
    });
}

// Write: set nextDue and reset status to unpaid
export async function updateExpenseNextDue(id, nextDue) {
  await updateDoc(doc(db, "expenses", id), {
    nextDue,
    status: "unpaid",
  });
}