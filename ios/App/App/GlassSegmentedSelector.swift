import SwiftUI

// MARK: - GlassSegmentOption

/// A single segment item — supports text-only or icon + text.
struct GlassSegmentOption: Identifiable, Equatable {
    let id: String
    let label: String
    let icon: String?       // SF Symbol name, optional

    init(_ label: String, icon: String? = nil) {
        self.id = label
        self.label = label
        self.icon = icon
    }
}

// MARK: - GlassSegmentedSelector

/// Reusable glassmorphism segmented selector.
///
/// String shorthand:
///   GlassSegmentedSelector(options: ["Expense", "Payment"], selected: $sel)
///
/// With icons:
///   GlassSegmentedSelector(
///       options: [.init("Add", icon: "plus"), .init("Pay", icon: "creditcard")],
///       selected: $sel
///   )
struct GlassSegmentedSelector: View {
    let options: [GlassSegmentOption]
    @Binding var selected: String

    /// Accent tint for the selected capsule. Defaults to semi-opaque white (works on any bg).
    var tint: Color = .white.opacity(0.22)
    /// Whether to fire haptic feedback on selection change.
    var haptics: Bool = true

    @Namespace private var selectionNamespace

    // String-array convenience initialiser
    init(options: [String], selected: Binding<String>, tint: Color = .white.opacity(0.22), haptics: Bool = true) {
        self.options   = options.map { GlassSegmentOption($0) }
        self._selected = selected
        self.tint      = tint
        self.haptics   = haptics
    }

    // GlassSegmentOption array initialiser
    init(options: [GlassSegmentOption], selected: Binding<String>, tint: Color = .white.opacity(0.22), haptics: Bool = true) {
        self.options   = options
        self._selected = selected
        self.tint      = tint
        self.haptics   = haptics
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options) { option in
                SegmentItem(
                    option:    option,
                    isSelected: selected == option.id,
                    namespace: selectionNamespace,
                    tint:      tint
                )
                .contentShape(Rectangle())
                .onTapGesture {
                    guard selected != option.id else { return }
                    if haptics {
                        let generator = UIImpactFeedbackGenerator(style: .light)
                        generator.impactOccurred()
                    }
                    withAnimation(.spring(response: 0.32, dampingFraction: 0.68, blendDuration: 0)) {
                        selected = option.id
                    }
                }
            }
        }
        .padding(5)
        .background {
            // Layered frosted glass pill
            Capsule(style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay {
                    // Soft white rim
                    Capsule(style: .continuous)
                        .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                }
                .overlay {
                    // Subtle inner top highlight
                    Capsule(style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [Color.white.opacity(0.06), Color.clear],
                                startPoint: .top,
                                endPoint: .center
                            )
                        )
                }
        }
        .shadow(color: .black.opacity(0.22), radius: 20, x: 0, y: 8)
        .shadow(color: .black.opacity(0.08), radius: 4,  x: 0, y: 2)
    }
}

// MARK: - SegmentItem

private struct SegmentItem: View {
    let option:     GlassSegmentOption
    let isSelected: Bool
    let namespace:  Namespace.ID
    let tint:       Color

    private let geometryID = "activeSegment"

    var body: some View {
        ZStack {
            // Sliding capsule — only present on the active item so
            // matchedGeometryEffect glides it smoothly.
            if isSelected {
                Capsule(style: .continuous)
                    .fill(tint)
                    .overlay {
                        // Inner white glow at the top edge
                        Capsule(style: .continuous)
                            .fill(
                                LinearGradient(
                                    colors: [Color.white.opacity(0.28), Color.clear],
                                    startPoint: .top,
                                    endPoint: .bottom
                                )
                            )
                    }
                    .overlay {
                        // Thin crisp border
                        Capsule(style: .continuous)
                            .strokeBorder(Color.white.opacity(0.40), lineWidth: 0.75)
                    }
                    .shadow(color: .white.opacity(0.10), radius: 6, x: 0, y: 3)
                    .matchedGeometryEffect(id: geometryID, in: namespace)
            }

            // Label row
            HStack(spacing: 5) {
                if let icon = option.icon {
                    Image(systemName: icon)
                        .font(.system(size: 13, weight: isSelected ? .semibold : .regular))
                        .symbolRenderingMode(.hierarchical)
                }
                Text(option.label)
                    .font(.system(size: 14, weight: isSelected ? .semibold : .regular, design: .rounded))
            }
            .foregroundStyle(
                isSelected
                    ? Color.white
                    : Color.white.opacity(0.50)
            )
            .animation(
                .spring(response: 0.32, dampingFraction: 0.68),
                value: isSelected
            )
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
        }
    }
}

// MARK: - Preview

#Preview("GlassSegmentedSelector") {
    struct PreviewWrapper: View {
        @State private var type     = "Expense"
        @State private var split    = "Split 50/50"
        @State private var method   = "Zelle"

        var body: some View {
            ZStack {
                // New palette — deep navy gradient
                LinearGradient(
                    colors: [
                        Color(red: 0/255, green: 49/255, blue: 75/255),   // #00314B
                        Color(red: 27/255, green: 77/255, blue: 107/255)  // #1B4D6B
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                .ignoresSafeArea()

                // Soft circle accents
                Circle()
                    .fill(Color(red: 166/255, green: 183/255, blue: 203/255).opacity(0.12))
                    .frame(width: 300, height: 300)
                    .offset(x: 120, y: -160)
                    .blur(radius: 60)

                Circle()
                    .fill(Color(red: 213/255, green: 189/255, blue: 150/255).opacity(0.10))
                    .frame(width: 260, height: 260)
                    .offset(x: -130, y: 200)
                    .blur(radius: 60)

                VStack(spacing: 36) {

                    // Header
                    VStack(spacing: 4) {
                        Text("Log Transaction")
                            .font(.system(size: 24, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                        Text("SplitTrack")
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(.white.opacity(0.45))
                    }

                    // Add Expense / Log Payment toggle
                    GlassSegmentedSelector(
                        options: [
                            .init("Expense",  icon: "plus.circle"),
                            .init("Payment",  icon: "creditcard")
                        ],
                        selected: $type
                    )

                    // Split option (3-way)
                    GlassSegmentedSelector(
                        options: [
                            .init("Split 50/50", icon: "person.2"),
                            .init("I pay",       icon: "person"),
                            .init("Cam pays",    icon: "person.fill")
                        ],
                        selected: $split
                    )

                    // Payment method (text-only, gold tint)
                    GlassSegmentedSelector(
                        options: ["Zelle", "Card", "Cash"],
                        selected: $method,
                        tint: Color(red: 213/255, green: 189/255, blue: 150/255).opacity(0.35)
                    )

                    // State readout
                    VStack(spacing: 6) {
                        label("Type",   type)
                        label("Split",  split)
                        label("Method", method)
                    }
                    .padding(.top, 8)
                }
                .padding(.horizontal, 28)
            }
        }

        private func label(_ key: String, _ value: String) -> some View {
            HStack {
                Text(key)
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.40))
                Spacer()
                Text(value)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.75))
            }
        }
    }

    return PreviewWrapper()
}
