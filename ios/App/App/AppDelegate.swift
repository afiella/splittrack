import UIKit
import Capacitor
import FirebaseCore

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {

        FirebaseApp.configure()

        // Register native plugins
        CAPBridgeViewController.add(pluginType: AddExpensePlugin.self, jsName: "AddExpense", pluginName: "AddExpense")

        return true
    }

}
