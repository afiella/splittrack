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

