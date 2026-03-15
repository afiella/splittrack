import UIKit
import Capacitor

class ViewController: CAPBridgeViewController {

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        #if DEBUG
        // In DEBUG builds, load from the local Vite dev server.
        // Start it with: npm run dev
        descriptor.serverURL = "http://localhost:5173"
        #endif
        // In RELEASE builds, serverURL stays nil and Capacitor loads
        // the bundled files from the app's public/ directory.
        return descriptor
    }
}
