/**
 * nativeAddExpense.js
 *
 * Presents the native SwiftUI AddExpense sheet on iOS via the Capacitor bridge.
 * Falls back gracefully to `null` on web/Android so the React modal shows instead.
 *
 * Usage in App.jsx:
 *   import { presentNativeAddExpense, isNativeIOS } from './nativeAddExpense';
 *
 *   // Replace the modal open with:
 *   async function handleAddExpenseTap() {
 *     if (isNativeIOS()) {
 *       const result = await presentNativeAddExpense();
 *       if (result && !result.cancelled) handleAddExpense(result);
 *     } else {
 *       setModal("addExpense");
 *     }
 *   }
 */

import { Capacitor } from '@capacitor/core';

/** True when running inside the Capacitor iOS wrapper. */
export function isNativeIOS() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}

/**
 * Present the native SwiftUI AddExpenseView sheet.
 * Returns the ExpenseFormData payload, or { cancelled: true } if dismissed.
 * Returns null if not on iOS native (caller should fall back to React modal).
 */
export async function presentNativeAddExpense() {
  if (!isNativeIOS()) return null;

  try {
    // Dynamically access the registered plugin to avoid import errors on web
    const { AddExpense } = Capacitor.Plugins;
    const result = await AddExpense.present();

    if (result.cancelled) return { cancelled: true };

    // Normalise the data to match what handleAddExpense() expects
    return {
      description:  result.description  || '',
      amount:       parseFloat(result.amount) || 0,
      category:     result.category     || 'Other',
      split:        normaliseSplit(result.split),
      account:      result.account      || 'Navy Platinum',
      recurring:    normaliseRecurring(result.recurring),
      dueDate:      result.dueDate      || null,
      endDate:      result.endDate      || null,
      nextDue:      result.dueDate      || null,
      note:         result.note         || undefined,
      referenceNum: result.referenceNum || undefined,
      mandatory:    result.mandatory    ?? false,
      date:         new Date().toISOString().slice(0, 10),
    };
  } catch (err) {
    console.warn('[nativeAddExpense] Plugin call failed:', err);
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Map SwiftUI display label → Firestore split key */
function normaliseSplit(label) {
  switch (label) {
    case 'I pay':     return 'ella';
    case 'Cam pays':  return 'cam';
    default:          return 'split'; // "Split 50/50"
  }
}

/** Map SwiftUI display label → Firestore recurring key */
function normaliseRecurring(label) {
  switch (label) {
    case 'Weekly':    return 'weekly';
    case 'Biweekly':  return 'biweekly';
    case 'Monthly':   return 'monthly';
    default:          return 'none'; // "One-time"
  }
}
