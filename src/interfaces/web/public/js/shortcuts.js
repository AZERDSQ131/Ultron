import * as palette from "./palette.js";
import * as inspector from "./inspector.js";
import { createNewChat, toggleSidebar } from "./chatList.js";
import { editLast, focusInput } from "./composer.js";

// Global, keyboard-first navigation — mirrors the Cmd/Ctrl+K-driven feel of
// Claude Code / Linear rather than requiring the mouse for anything that
// isn't the message thread itself. Listed in full in the Shortcuts tab of
// the inspector (index.html), kept in sync by hand since there are few
// enough bindings that a generated list would be more indirection than help.
export function initShortcuts() {
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;

    if (e.key === "Escape") {
      if (palette.isOpen()) {
        e.preventDefault();
        palette.close();
      } else if (inspector.isOpen()) {
        e.preventDefault();
        inspector.close();
      }
      return;
    }

    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      palette.isOpen() ? palette.close() : palette.open();
      return;
    }

    if (mod && e.key.toLowerCase() === "n") {
      e.preventDefault();
      createNewChat();
      return;
    }

    if (mod && e.key === ",") {
      e.preventDefault();
      inspector.isOpen() ? inspector.close() : inspector.open("settings");
      return;
    }

    if (mod && e.key === "/") {
      e.preventDefault();
      inspector.isOpen() ? inspector.close() : inspector.open("shortcuts");
      return;
    }

    if (mod && e.key.toLowerCase() === "b") {
      e.preventDefault();
      toggleSidebar();
      return;
    }

    if (mod && e.key === "ArrowUp" && document.activeElement?.id === "input") {
      e.preventDefault();
      editLast();
      return;
    }

    // A bare "/" focuses the composer, as long as the user isn't already
    // typing somewhere (a text input, the palette, a chat-rename field).
    // Deliberately not preventDefault()'d: focusing here still lets the
    // browser deliver the "/" keystroke itself to the newly focused
    // textarea, which is what actually opens the slash command menu.
    if (e.key === "/" && !mod) {
      const tag = document.activeElement?.tagName;
      const isTyping = tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable;
      if (!isTyping) focusInput();
    }
  });
}
