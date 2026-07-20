import { initThread } from "./thread.js";
import { initChatList, loadChats, selectChat, createNewChat } from "./chatList.js";
import { initComposer, editLast, regenerateLast, focusInput } from "./composer.js";
import { initInspector } from "./inspector.js";
import { initPalette } from "./palette.js";
import { initShortcuts } from "./shortcuts.js";
import { state } from "./store.js";
import { initAutomation } from "./automation.js";
import { initTodos } from "./todos.js";
import { initArchivePanel } from "./archivePanel.js";
import { initHealthView } from "./healthView.js";
import { initGoalWidget } from "./goalWidget.js";

initThread({ onEditLast: editLast, onRegenerateLast: regenerateLast });
initChatList({ onAfterSelect: focusInput });
initComposer();
initInspector();
initPalette();
initShortcuts();
initAutomation();
initTodos();
initArchivePanel();
initHealthView();
initGoalWidget();

(async () => {
  await loadChats();
  const initial = state.chatsCache[0];
  if (initial) await selectChat(initial.id);
  else await createNewChat();
})();
