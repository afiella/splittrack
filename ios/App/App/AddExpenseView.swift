import SwiftUI

// MARK: - Data Models

struct ExpenseFormData {
    var description: String   = ""
    var amount:      String   = ""
    var category:    String   = "Groceries"
    var split:       String   = "Split 50/50"
    var account:     String   = "Navy Platinum"
    var recurring:   String   = "One-time"
    var dueDate:     Date?    = nil
    var endDate:     Date?    = nil
    var note:        String   = ""
    var referenceNum: String  = ""
    var mandatory:   Bool     = false
}

// MARK: - AddExpenseView

struct AddExpenseView: View {

    var onSave:   (ExpenseFormData) -> Void
    var onCancel: () -> Void

    @State private var form          = ExpenseFormData()
    @State private var showDetails   = false
    @State private var showDatePicker = false
    @State private var showEndDate   = false
    @FocusState private var amountFocused: Bool

    @State private var appeared      = false
    @State private var amountScale: CGFloat = 1.0

    // Palette
    private let navy    = Color(hex: "#00314B")
    private let midNavy = Color(hex: "#1B4D6B")
    private let steel   = Color(hex: "#A6B7CB")
    private let gold    = Color(hex: "#D5BD96")
    private let sage    = Color(hex: "#A6B49E")
    private let teal    = Color(hex: "#4E635E")
    private let cream   = Color(hex: "#F5F1EB")

    private let categories  = ["Groceries","Dining","Utilities","Rent","Subscriptions","Transport","Health","Shopping","Travel","Other"]
    private let splitOpts   = ["Split 50/50", "I pay", "Cam pays"]
    private let recurOpts   = ["One-time", "Weekly", "Biweekly", "Monthly"]
    private let accountOpts = ["Navy Platinum", "Best Buy Visa", "Debit Card", "Klarna", "Cash", "Zelle"]

    private var isRecurring: Bool { form.recurring != "One-time" }
    private var canSave:     Bool { !form.description.isEmpty && !form.amount.isEmpty }

    var body: some View {
        ZStack(alignment: .bottom) {
            // Dim backdrop
            Color.black.opacity(0.45)
                .ignoresSafeArea()
                .onTapGesture { onCancel() }

            // Sheet
            VStack(spacing: 0) {
                // Drag handle
                Capsule()
                    .fill(Color.white.opacity(0.25))
                    .frame(width: 40, height: 4)
                    .padding(.top, 10)
                    .padding(.bottom, 6)

                ScrollView(showsIndicators: false) {
                    VStack(spacing: 14) {

                        // ── Header ──────────────────────────────────
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Add Expense")
                                    .font(.system(size: 22, weight: .bold, design: .rounded))
                                    .foregroundStyle(.white)
                                Text("SplitTrack")
                                    .font(.system(size: 12, weight: .medium, design: .rounded))
                                    .foregroundStyle(.white.opacity(0.40))
                            }
                            Spacer()
                            Button(action: onCancel) {
                                Image(systemName: "xmark")
                                    .font(.system(size: 14, weight: .bold))
                                    .foregroundStyle(.white.opacity(0.70))
                                    .frame(width: 32, height: 32)
                                    .background(.white.opacity(0.12))
                                    .clipShape(Circle())
                            }
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 4)
                        .padding(.bottom, 2)
                        .cardEntrance(appeared: appeared, delay: 0.02)

                        // ── WHAT ────────────────────────────────────
                        GlassCard(label: "What", icon: "tag") {
                            // Description
                            TextField("e.g. Netflix, Wegmans…", text: $form.description)
                                .font(.system(size: 16, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white)
                                .tint(gold)
                                .glassInput()

                            // Category chips
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 7) {
                                    ForEach(categories, id: \.self) { cat in
                                        CategoryChip(
                                            label: cat,
                                            isSelected: form.category == cat,
                                            accentColor: gold
                                        )
                                        .onTapGesture {
                                            withAnimation(.spring(response: 0.28, dampingFraction: 0.7)) {
                                                form.category = cat
                                            }
                                        }
                                    }
                                }
                                .padding(.vertical, 2)
                            }

                            // Add details toggle
                            Button {
                                withAnimation(.spring(response: 0.32, dampingFraction: 0.72)) {
                                    showDetails.toggle()
                                }
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: "list.bullet")
                                        .font(.system(size: 12))
                                    Text(showDetails ? "Hide details" : "Add details")
                                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                                    Image(systemName: "chevron.down")
                                        .font(.system(size: 10, weight: .semibold))
                                        .rotationEffect(.degrees(showDetails ? 180 : 0))
                                        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: showDetails)
                                }
                                .foregroundStyle(.white.opacity(showDetails ? 0.80 : 0.42))
                            }
                            .buttonStyle(.plain)

                            if showDetails {
                                VStack(spacing: 8) {
                                    // Reference number
                                    HStack(spacing: 8) {
                                        Image(systemName: "tag.fill")
                                            .font(.system(size: 12))
                                            .foregroundStyle(gold.opacity(0.7))
                                        TextField("Reference # — TXN-4821, Order ID…", text: $form.referenceNum)
                                            .font(.system(size: 13, weight: .medium, design: .rounded))
                                            .foregroundStyle(.white)
                                            .tint(gold)
                                    }
                                    .glassInput(compact: true)

                                    // Notes
                                    TextField("Extra context, links, reminders…", text: $form.note, axis: .vertical)
                                        .lineLimit(3...5)
                                        .font(.system(size: 13, weight: .regular, design: .rounded))
                                        .foregroundStyle(.white)
                                        .tint(gold)
                                        .glassInput(compact: true)
                                }
                                .transition(.move(edge: .top).combined(with: .opacity))
                            }
                        }
                        .cardEntrance(appeared: appeared, delay: 0.08)

                        // ── HOW MUCH ────────────────────────────────
                        GlassCard(
                            label: "How Much",
                            icon: "dollarsign.circle",
                            glowColor: amountFocused ? gold : nil
                        ) {
                            HStack(alignment: .firstTextBaseline, spacing: 4) {
                                Text("$")
                                    .font(.system(size: 32, weight: .bold, design: .rounded))
                                    .foregroundStyle(gold.opacity(0.75))

                                TextField("0.00", text: $form.amount)
                                    .font(.system(size: 44, weight: .heavy, design: .rounded))
                                    .foregroundStyle(.white)
                                    .tint(gold)
                                    .keyboardType(.decimalPad)
                                    .focused($amountFocused)
                                    .multilineTextAlignment(.leading)
                                    .scaleEffect(amountScale, anchor: .leading)
                                    .onChange(of: form.amount) { _, _ in
                                        withAnimation(.spring(response: 0.20, dampingFraction: 0.50)) {
                                            amountScale = 1.06
                                        }
                                        withAnimation(.spring(response: 0.28, dampingFraction: 0.70).delay(0.10)) {
                                            amountScale = 1.0
                                        }
                                    }
                            }
                            .padding(.vertical, 6)
                        }
                        .animation(.easeInOut(duration: 0.22), value: amountFocused)
                        .cardEntrance(appeared: appeared, delay: 0.14)

                        // ── WHO PAYS ────────────────────────────────
                        GlassCard(label: "Who Pays", icon: "person.2") {
                            GlassSegmentedSelector(
                                options: splitOpts,
                                selected: $form.split,
                                tint: .white.opacity(0.22)
                            )
                        }
                        .cardEntrance(appeared: appeared, delay: 0.20)

                        // ── WHEN ────────────────────────────────────
                        GlassCard(
                            label: "When",
                            icon: "calendar",
                            badge: isRecurring ? "RECURRING" : nil
                        ) {
                            // Frequency
                            GlassSegmentedSelector(
                                options: recurOpts,
                                selected: $form.recurring,
                                tint: steel.opacity(0.30)
                            )

                            // Due date row
                            if !isRecurring {
                                DateToggleRow(
                                    label: "Due date",
                                    subLabel: "optional",
                                    date: $form.dueDate,
                                    accentColor: steel
                                )
                            } else {
                                HStack(spacing: 10) {
                                    DateToggleRow(
                                        label: "Start",
                                        subLabel: "required",
                                        date: $form.dueDate,
                                        accentColor: steel
                                    )
                                    DateToggleRow(
                                        label: "End",
                                        subLabel: "optional",
                                        date: $form.endDate,
                                        accentColor: steel.opacity(0.6)
                                    )
                                }
                            }

                            // Mandatory toggle
                            MandatoryToggleRow(isOn: $form.mandatory)
                        }
                        .cardEntrance(appeared: appeared, delay: 0.26)

                        // ── Source of payment ───────────────────────
                        GlassCard(label: "Payment Source", icon: "creditcard") {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 7) {
                                    ForEach(accountOpts, id: \.self) { acc in
                                        CategoryChip(
                                            label: acc,
                                            isSelected: form.account == acc,
                                            accentColor: steel
                                        )
                                        .onTapGesture {
                                            withAnimation(.spring(response: 0.28, dampingFraction: 0.7)) {
                                                form.account = acc
                                            }
                                        }
                                    }
                                }
                                .padding(.vertical, 2)
                            }
                        }
                        .cardEntrance(appeared: appeared, delay: 0.32)

                        // ── Save button ─────────────────────────────
                        Button {
                            guard canSave else { return }
                            let impact = UIImpactFeedbackGenerator(style: .medium)
                            impact.impactOccurred()
                            onSave(form)
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 18))
                                Text("Save Expense")
                                    .font(.system(size: 16, weight: .bold, design: .rounded))
                            }
                            .foregroundStyle(canSave ? .white : .white.opacity(0.35))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 16)
                            .background {
                                RoundedRectangle(cornerRadius: 18, style: .continuous)
                                    .fill(
                                        canSave
                                            ? LinearGradient(colors: [navy, midNavy], startPoint: .leading, endPoint: .trailing)
                                            : LinearGradient(colors: [Color.white.opacity(0.08), Color.white.opacity(0.06)], startPoint: .leading, endPoint: .trailing)
                                    )
                                    .overlay {
                                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                                            .strokeBorder(canSave ? Color.white.opacity(0.20) : Color.clear, lineWidth: 1)
                                    }
                            }
                            .shadow(color: canSave ? navy.opacity(0.5) : .clear, radius: 12, x: 0, y: 6)
                        }
                        .buttonStyle(BouncyButtonStyle())
                        .disabled(!canSave)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 8)
                        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: canSave)
                        .cardEntrance(appeared: appeared, delay: 0.38)

                        Spacer(minLength: 24)
                    }
                    .padding(.bottom, 20)
                }
            }
            .background {
                // Frosted glass sheet with deep navy tint
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(hex: "#00314B").opacity(0.96),
                                Color(hex: "#1B4D6B").opacity(0.94)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: 28, style: .continuous)
                            .fill(.ultraThinMaterial.opacity(0.3))
                    }
                    .overlay {
                        // Top rim highlight
                        RoundedRectangle(cornerRadius: 28, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
                    }
                    .ignoresSafeArea(edges: .bottom)
            }
            .shadow(color: .black.opacity(0.35), radius: 40, x: 0, y: -10)
        }
        .onAppear {
            amountFocused = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                withAnimation(.spring(response: 0.52, dampingFraction: 0.80)) {
                    appeared = true
                }
            }
        }
    }
}

// MARK: - GlassCard

private struct GlassCard<Content: View>: View {
    let label:     String
    let icon:      String
    var badge:     String? = nil
    var glowColor: Color?  = nil   // active focus glow
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Section label
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white.opacity(0.45))
                Text(label.uppercased())
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.45))
                    .kerning(1.0)
                if let badge {
                    Text(badge)
                        .font(.system(size: 9, weight: .heavy, design: .rounded))
                        .foregroundStyle(Color(hex: "#D5BD96"))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Color(hex: "#D5BD96").opacity(0.15))
                        .clipShape(Capsule())
                }
            }

            content
        }
        .padding(16)
        .background {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(.white.opacity(0.06))
                .overlay {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(
                            glowColor?.opacity(0.55) ?? Color.white.opacity(0.10),
                            lineWidth: glowColor != nil ? 1.5 : 1
                        )
                }
                .shadow(color: glowColor?.opacity(0.28) ?? .clear, radius: 12, x: 0, y: 0)
        }
        .padding(.horizontal, 16)
    }
}

// MARK: - CategoryChip

private struct CategoryChip: View {
    let label:       String
    let isSelected:  Bool
    let accentColor: Color

    var body: some View {
        Text(label)
            .font(.system(size: 12, weight: isSelected ? .bold : .medium, design: .rounded))
            .foregroundStyle(isSelected ? .white : .white.opacity(0.50))
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background {
                Capsule(style: .continuous)
                    .fill(isSelected ? accentColor.opacity(0.28) : Color.white.opacity(0.07))
                    .overlay {
                        Capsule(style: .continuous)
                            .strokeBorder(isSelected ? accentColor.opacity(0.55) : Color.white.opacity(0.12), lineWidth: 1)
                    }
            }
    }
}

// MARK: - DateToggleRow

private struct DateToggleRow: View {
    let label:       String
    let subLabel:    String
    @Binding var date: Date?
    let accentColor: Color

    @State private var expanded = false

    private var dateText: String {
        guard let d = date else { return subLabel }
        return d.formatted(date: .abbreviated, time: .omitted)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.spring(response: 0.32, dampingFraction: 0.72)) {
                    expanded.toggle()
                    if date == nil && expanded { date = Date() }
                    if !expanded { date = nil }
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: expanded ? "calendar.badge.minus" : "calendar.badge.plus")
                        .font(.system(size: 12))
                        .foregroundStyle(accentColor)
                    Text(label)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                    Spacer()
                    Text(dateText)
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.55))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10))
                        .foregroundStyle(.white.opacity(0.30))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
            }
            .buttonStyle(.plain)

            if expanded, let binding = Binding($date) {
                DatePicker("", selection: binding, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .tint(accentColor)
                    .colorScheme(.dark)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .padding(12)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.05))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(expanded ? accentColor.opacity(0.35) : Color.white.opacity(0.08), lineWidth: 1)
                }
        }
    }
}

// MARK: - MandatoryToggleRow

private struct MandatoryToggleRow: View {
    @Binding var isOn: Bool

    var body: some View {
        Button {
            withAnimation(.spring(response: 0.32, dampingFraction: 0.7)) {
                isOn.toggle()
            }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } label: {
            HStack(spacing: 12) {
                // Shield icon
                ZStack {
                    Circle()
                        .fill(isOn ? Color(hex: "#E05C6E").opacity(0.20) : Color.white.opacity(0.06))
                        .frame(width: 34, height: 34)
                    Image(systemName: "shield.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(isOn ? Color(hex: "#E05C6E") : .white.opacity(0.30))
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text("Mandatory")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(isOn ? Color(hex: "#E05C6E") : .white)
                    Text("Cannot be late — alerts Cameron earlier")
                        .font(.system(size: 11, weight: .regular, design: .rounded))
                        .foregroundStyle(.white.opacity(0.40))
                }

                Spacer()

                // Toggle pill
                Capsule()
                    .fill(isOn ? Color(hex: "#E05C6E") : Color.white.opacity(0.15))
                    .frame(width: 40, height: 24)
                    .overlay(alignment: isOn ? .trailing : .leading) {
                        Circle()
                            .fill(.white)
                            .frame(width: 18, height: 18)
                            .shadow(color: .black.opacity(0.18), radius: 3, x: 0, y: 1)
                            .padding(.horizontal, 3)
                    }
            }
            .padding(12)
            .background {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(isOn ? Color(hex: "#E05C6E").opacity(0.08) : Color.white.opacity(0.05))
                    .overlay {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(isOn ? Color(hex: "#E05C6E").opacity(0.35) : Color.white.opacity(0.08), lineWidth: 1)
                    }
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Input modifier

private struct GlassInputModifier: ViewModifier {
    var compact: Bool = false

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 14)
            .padding(.vertical, compact ? 10 : 13)
            .background {
                RoundedRectangle(cornerRadius: compact ? 10 : 13, style: .continuous)
                    .fill(Color.white.opacity(0.07))
                    .overlay {
                        RoundedRectangle(cornerRadius: compact ? 10 : 13, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
                    }
            }
    }
}

private extension View {
    func glassInput(compact: Bool = false) -> some View {
        modifier(GlassInputModifier(compact: compact))
    }

    /// Staggered entrance: slides up from an offset and fades in.
    func cardEntrance(appeared: Bool, delay: Double = 0) -> some View {
        self
            .offset(y: appeared ? 0 : 24)
            .opacity(appeared ? 1 : 0)
            .animation(.spring(response: 0.50, dampingFraction: 0.82).delay(delay), value: appeared)
    }
}

// MARK: - BouncyButtonStyle

private struct BouncyButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1.0)
            .animation(.spring(response: 0.25, dampingFraction: 0.58), value: configuration.isPressed)
    }
}

// MARK: - Color hex helper

private extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let r = Double((int >> 16) & 0xFF) / 255
        let g = Double((int >> 8)  & 0xFF) / 255
        let b = Double(int         & 0xFF) / 255
        self.init(red: r, green: g, blue: b)
    }
}

// MARK: - Preview

#Preview("Add Expense Sheet") {
    struct Wrapper: View {
        @State private var show = true

        var body: some View {
            ZStack {
                LinearGradient(
                    colors: [Color(red: 0.96, green: 0.95, blue: 0.92), Color(red: 0.90, green: 0.88, blue: 0.84)],
                    startPoint: .top, endPoint: .bottom
                )
                .ignoresSafeArea()

                if show {
                    AddExpenseView(
                        onSave: { data in
                            print("Saved:", data.description, data.amount)
                            show = false
                        },
                        onCancel: { show = false }
                    )
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }

                if !show {
                    Button("Show Sheet") { withAnimation(.spring()) { show = true } }
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .padding(.horizontal, 24).padding(.vertical, 12)
                        .background(Color(red: 0, green: 49/255, blue: 75/255))
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                }
            }
        }
    }
    return Wrapper()
}
