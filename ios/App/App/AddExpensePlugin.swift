import UIKit
import SwiftUI
import Capacitor

// MARK: - AddExpensePlugin
//
// Capacitor plugin that presents the native SwiftUI AddExpenseView sheet.
//
// JS usage (from React):
//   import { Plugins } from '@capacitor/core';
//   const { AddExpense } = Plugins;
//   const result = await AddExpense.present();
//   // result.data is the saved expense JSON, or result.cancelled = true

@objc(AddExpensePlugin)
public class AddExpensePlugin: CAPPlugin {

    @objc func present(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let rootVC = self.bridge?.viewController else {
                call.reject("No root view controller")
                return
            }

            // Wrap AddExpenseView in a UIHostingController
            let hostingVC = UIHostingController(
                rootView: AddExpenseView(
                    onSave: { [weak rootVC] formData in
                        // Dismiss the sheet
                        rootVC?.dismiss(animated: true) {
                            // Resolve the Capacitor call with the form data as JSON
                            call.resolve([
                                "cancelled":    false,
                                "description":  formData.description,
                                "amount":       formData.amount,
                                "category":     formData.category,
                                "split":        formData.split,
                                "account":      formData.account,
                                "recurring":    formData.recurring,
                                "dueDate":      formData.dueDate.map { ISO8601DateFormatter().string(from: $0) } as Any,
                                "endDate":      formData.endDate.map { ISO8601DateFormatter().string(from: $0) } as Any,
                                "note":         formData.note,
                                "referenceNum": formData.referenceNum,
                                "mandatory":    formData.mandatory,
                            ])
                        }
                    },
                    onCancel: { [weak rootVC] in
                        rootVC?.dismiss(animated: true) {
                            call.resolve(["cancelled": true])
                        }
                    }
                )
            )

            // Transparent background so the dim overlay shows correctly
            hostingVC.modalPresentationStyle   = .overFullScreen
            hostingVC.modalTransitionStyle     = .coverVertical
            hostingVC.view.backgroundColor     = .clear

            rootVC.present(hostingVC, animated: true)
        }
    }
}
