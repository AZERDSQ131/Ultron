// Shared mutable state for the whole app. Deliberately a plain object with
// no pub-sub: the app is small enough that each module just calls the
// relevant render function after mutating state, rather than paying for a
// reactivity layer no one needs here.
export const state = {
  generating: false,
  verbose: false,
  thinkingMode: "full",
  securityMode: "bypass",
  activeChatId: null,
  chatsCache: [],
  agentsCache: [],
  toolScopes: {},
};
