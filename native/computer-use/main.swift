// ULTRON computer-use helper — a small standalone CLI that talks to macOS's
// Accessibility API (AXUIElement) and CoreGraphics event APIs directly.
// Compiled by src/core/tools/computer.ts on first use (see ensureHelperBuilt),
// not checked in as a binary, since it's ~arm64/x86_64 and toolchain specific.
//
// This exists instead of clicking at raw screen pixels: it dumps a structured,
// semantic tree of the frontmost (or a given) app's UI — role, title, value,
// frame — and lets an action address a specific element by its path in that
// tree, resolving to a real AXUIElement (preferring AXPress) or a physical
// click at that element's actual frame center as fallback. Both the dump and
// the action re-derive the same element the same way (walking AXChildren
// indices from the app root), so no live handle needs to survive between the
// two separate process invocations.
import ApplicationServices
import AppKit
import Foundation

// MARK: - Output helpers

func printJSON(_ obj: Any) {
    let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
    printJSON(["error": message])
    exit(1)
}

// MARK: - AX attribute helpers

func axAttr(_ element: AXUIElement, _ attr: String) -> AnyObject? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
    return result == .success ? value : nil
}

func axString(_ element: AXUIElement, _ attr: String) -> String? {
    axAttr(element, attr) as? String
}

func axBool(_ element: AXUIElement, _ attr: String) -> Bool? {
    axAttr(element, attr) as? Bool
}

func axPoint(_ element: AXUIElement, _ attr: String) -> CGPoint? {
    guard let raw = axAttr(element, attr) else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(raw as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func axSize(_ element: AXUIElement, _ attr: String) -> CGSize? {
    guard let raw = axAttr(element, attr) else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(raw as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    (axAttr(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func checkTrusted() {
    if !AXIsProcessTrusted() {
        fail(
            "Accessibility permission not granted to this helper binary. " +
            "Open System Settings > Privacy & Security > Accessibility and enable it for: " +
            CommandLine.arguments[0]
        )
    }
}

// MARK: - Tree

let INTERESTING_ROLES: Set<String> = [
    "AXButton", "AXMenuItem", "AXMenuBarItem", "AXCheckBox", "AXRadioButton", "AXTextField",
    "AXTextArea", "AXLink", "AXPopUpButton", "AXComboBox", "AXSlider", "AXTab", "AXStaticText",
    "AXCell", "AXDisclosureTriangle", "AXWindow", "AXSearchField", "AXRow",
]

struct Node {
    var path: [Int]
    var role: String
    var title: String?
    var value: String?
    var desc: String?
    var enabled: Bool
    var frame: CGRect?
    var children: [Node]
}

func buildTree(_ element: AXUIElement, path: [Int], depth: Int, maxDepth: Int) -> Node {
    let role = axString(element, kAXRoleAttribute as String) ?? "Unknown"
    let title = axString(element, kAXTitleAttribute as String)
    let value = axAttr(element, kAXValueAttribute as String) as? String
    let desc = axString(element, kAXDescriptionAttribute as String)
    let enabled = axBool(element, kAXEnabledAttribute as String) ?? true

    var frame: CGRect? = nil
    if let pos = axPoint(element, kAXPositionAttribute as String),
        let size = axSize(element, kAXSizeAttribute as String)
    {
        frame = CGRect(origin: pos, size: size)
    }

    var children: [Node] = []
    if depth < maxDepth {
        for (index, child) in axChildren(element).enumerated() {
            children.append(buildTree(child, path: path + [index], depth: depth + 1, maxDepth: maxDepth))
        }
    }

    return Node(path: path, role: role, title: title, value: value, desc: desc, enabled: enabled, frame: frame, children: children)
}

// Collapses generic, attribute-less single-child wrapper nodes (AXGroup and
// friends) down to their child, and drops zero-size/invisible leaves — real
// UI trees are dominated by these and they blow up token count for no
// benefit to the model deciding what to click.
func prune(_ node: Node) -> Node? {
    let children = node.children.compactMap(prune)
    let visible = node.frame.map { $0.width > 0 && $0.height > 0 } ?? false
    let hasContent = !(node.title ?? "").isEmpty || !(node.value ?? "").isEmpty || !(node.desc ?? "").isEmpty
    let interesting = INTERESTING_ROLES.contains(node.role)

    if !visible && children.isEmpty { return nil }
    if !interesting && !hasContent && children.count == 1 { return children[0] }

    var result = node
    result.children = children
    return result
}

func nodeToDict(_ node: Node) -> [String: Any] {
    var dict: [String: Any] = ["path": node.path, "role": node.role]
    if !node.enabled { dict["enabled"] = false }
    if let t = node.title, !t.isEmpty { dict["title"] = t }
    if let v = node.value, !v.isEmpty { dict["value"] = v }
    if let d = node.desc, !d.isEmpty { dict["description"] = d }
    if let f = node.frame {
        dict["frame"] = ["x": f.origin.x, "y": f.origin.y, "width": f.width, "height": f.height]
    }
    if !node.children.isEmpty { dict["children"] = node.children.map(nodeToDict) }
    return dict
}

func resolveElement(pid: pid_t, path: [Int]) -> AXUIElement? {
    var current = AXUIElementCreateApplication(pid)
    for index in path {
        let children = axChildren(current)
        guard index >= 0, index < children.count else { return nil }
        current = children[index]
    }
    return current
}

// MARK: - CGEvent input

func postClick(at point: CGPoint) {
    let source = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
    let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    down?.post(tap: .cghidEventTap)
    usleep(30_000)
    up?.post(tap: .cghidEventTap)
}

func postScroll(at point: CGPoint, direction: String, amount: Int32) {
    let source = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?
        .post(tap: .cghidEventTap)
    let vertical = (direction == "up" || direction == "down") ? (direction == "up" ? amount : -amount) : 0
    let horizontal = (direction == "left" || direction == "right") ? (direction == "right" ? amount : -amount) : 0
    let scroll = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0)
    scroll?.post(tap: .cghidEventTap)
}

func typeUnicodeText(_ text: String) {
    let source = CGEventSource(stateID: .hidSystemState)
    for scalar in text.utf16.map({ [$0] }) {
        let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: scalar.count, unicodeString: scalar)
        down?.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: scalar.count, unicodeString: scalar)
        up?.post(tap: .cghidEventTap)
        usleep(4_000)
    }
}

let KEYCODES: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
    "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "equal": 24, "9": 25, "7": 26, "minus": 27, "8": 28, "0": 29, "rightbracket": 30, "o": 31, "u": 32,
    "leftbracket": 33, "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38, "quote": 39,
    "k": 40, "semicolon": 41, "backslash": 42, "comma": 43, "slash": 44, "n": 45, "m": 46, "period": 47,
    "tab": 48, "space": 49, "grave": 50, "backspace": 51, "escape": 53, "esc": 53,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
    "f10": 109, "f11": 103, "f12": 111,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "delete": 117, "forwarddelete": 117,
]

func flagsFor(_ modifier: String) -> CGEventFlags? {
    switch modifier {
    case "cmd", "command", "super": return .maskCommand
    case "ctrl", "control": return .maskControl
    case "alt", "option": return .maskAlternate
    case "shift": return .maskShift
    default: return nil
    }
}

func pressCombo(_ combo: String) {
    let parts = combo.lowercased().split(separator: "+").map(String.init)
    guard let last = parts.last, let keyCode = KEYCODES[last] else { fail("unrecognized key: \(combo)") }
    var flags: CGEventFlags = []
    for modifier in parts.dropLast() {
        guard let flag = flagsFor(modifier) else { fail("unrecognized modifier: \(modifier)") }
        flags.insert(flag)
    }
    let source = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)
    down?.flags = flags
    down?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
    up?.flags = flags
    up?.post(tap: .cghidEventTap)
}

// MARK: - Commands

func cmdFrontmost() {
    guard let app = NSWorkspace.shared.frontmostApplication else { fail("no frontmost application") }
    printJSON([
        "pid": app.processIdentifier,
        "name": app.localizedName ?? "Unknown",
        "bundleId": app.bundleIdentifier as Any,
    ])
}

func cmdTree(pid: pid_t, maxDepth: Int) {
    checkTrusted()
    let root = AXUIElementCreateApplication(pid)
    let tree = buildTree(root, path: [], depth: 0, maxDepth: maxDepth)
    guard let pruned = prune(tree) else { fail("empty tree") }
    printJSON(nodeToDict(pruned))
}

func cmdOpen(name: String) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    task.arguments = ["-a", name]
    do {
        try task.run()
        task.waitUntilExit()
    } catch {
        fail("failed to run open: \(error.localizedDescription)")
    }
    if task.terminationStatus != 0 { fail("open -a \"\(name)\" exited with status \(task.terminationStatus)") }
    printJSON(["ok": true])
}

func cmdClick(pid: pid_t, path: [Int]) {
    checkTrusted()
    guard let element = resolveElement(pid: pid, path: path) else { fail("element not found at path \(path)") }
    if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
        printJSON(["ok": true, "method": "ax_press"])
        return
    }
    guard let pos = axPoint(element, kAXPositionAttribute as String), let size = axSize(element, kAXSizeAttribute as String) else {
        fail("element has no frame and does not support AXPress")
    }
    let center = CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
    postClick(at: center)
    printJSON(["ok": true, "method": "cg_click", "x": center.x, "y": center.y])
}

func cmdScroll(pid: pid_t, path: [Int], direction: String, amount: Int32) {
    checkTrusted()
    guard let element = resolveElement(pid: pid, path: path) else { fail("element not found at path \(path)") }
    guard let pos = axPoint(element, kAXPositionAttribute as String), let size = axSize(element, kAXSizeAttribute as String) else {
        fail("element has no frame")
    }
    let center = CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
    postScroll(at: center, direction: direction, amount: amount)
    printJSON(["ok": true])
}

func cmdType() {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    let text = String(data: data, encoding: .utf8) ?? ""
    typeUnicodeText(text)
    printJSON(["ok": true])
}

func cmdKey(combo: String) {
    pressCombo(combo)
    printJSON(["ok": true])
}

// MARK: - Dispatch

let args = CommandLine.arguments
guard args.count > 1 else { fail("usage: computer-use-helper <frontmost|tree|open|click|scroll|type|key> ...") }

switch args[1] {
case "frontmost":
    cmdFrontmost()
case "tree":
    guard args.count >= 4, let pid = pid_t(args[2]), let maxDepth = Int(args[3]) else {
        fail("usage: tree <pid> <maxDepth>")
    }
    cmdTree(pid: pid, maxDepth: maxDepth)
case "open":
    guard args.count >= 3 else { fail("usage: open <appName>") }
    cmdOpen(name: args[2...].joined(separator: " "))
case "click":
    guard args.count >= 4, let pid = pid_t(args[2]) else { fail("usage: click <pid> <path e.g. 0,3,1>") }
    let path = args[3] == "" ? [] : args[3].split(separator: ",").compactMap { Int($0) }
    cmdClick(pid: pid, path: path)
case "scroll":
    guard args.count >= 6, let pid = pid_t(args[2]), let amount = Int32(args[5]) else {
        fail("usage: scroll <pid> <path> <up|down|left|right> <amount>")
    }
    let path = args[3] == "" ? [] : args[3].split(separator: ",").compactMap { Int($0) }
    cmdScroll(pid: pid, path: path, direction: args[4], amount: amount)
case "type":
    cmdType()
case "key":
    guard args.count >= 3 else { fail("usage: key <combo, e.g. cmd+space>") }
    cmdKey(combo: args[2])
default:
    fail("unknown command: \(args[1])")
}
