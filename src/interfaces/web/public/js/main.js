import { initThread } from "./thread.js";
import { initChatList, loadChats, selectChat, createNewChat, getChat } from "./chatList.js";
import { initComposer, editLast, regenerateLast, focusInput, onObserveBack } from "./composer.js";
import { initInspector } from "./inspector.js";
import { initPalette } from "./palette.js";
import { initShortcuts } from "./shortcuts.js";
import { state } from "./store.js";
import { initTodos } from "./todos.js";
import { initArchivePanel } from "./archivePanel.js";
import { initHealthView } from "./healthView.js";
import { initUsageView } from "./usageView.js";
import { initFinanceView } from "./financeView.js";
import { initGoalWidget } from "./goalWidget.js";

initThread({ onEditLast: editLast, onRegenerateLast: regenerateLast });
initChatList({ onAfterSelect: focusInput });
initComposer();
initInspector();
initPalette();
initShortcuts();
initTodos();
initArchivePanel();
initHealthView();
initUsageView();
initFinanceView();
initGoalWidget();

// Clicking "Observer" on a spawn_agent block opens that sub-agent's own
// conversation (thread.js dispatches this; wired here so thread.js doesn't have
// to import chatList and create a cycle).
window.addEventListener("subagent:open", async (event) => {
  const chatId = event.detail?.chatId;
  if (!chatId) return;
  // A sub-agent chat created during this session isn't in the cached list yet.
  if (!getChat(chatId)) await loadChats();
  await selectChat(chatId);
});

onObserveBack(async () => {
  const parentId = getChat(state.activeChatId)?.parentChatId;
  if (parentId) await selectChat(parentId);
});

(async () => {
  await loadChats();
  const initial = state.chatsCache[0];
  if (initial) await selectChat(initial.id);
  else await createNewChat();
})();
