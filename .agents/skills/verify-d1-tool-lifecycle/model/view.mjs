// Chart words for model/D1ToolLifecycle.tla, for /statechart --view.
export const title = "D1 Studio: one tool call, from mount to answer";

export const state = (v) => {
  if (v.screen === "loading") return v.by === "retry" ? "Running again" : "Loading";
  if (v.screen === "answer") return "Result shown";
  if (v.screen === "error")
    return v.drawnTool && v.drawnInput && v.serverTools ? "Error shown, with Try again" : "Error shown";
  if (v.screen === "cancelled") return "Cancelled";
  return "Could not connect";
};

export const group = (v) =>
  v.screen === "loading" ? "waiting" : v.screen === "answer" ? "done" : "stopped";

export const colors = { waiting: "blue", done: "teal", stopped: "tan" };

export const step = (action, from, to) => {
  switch (action) {
    // Hidden (each is all of its arrow): a failed connect after an error or
    // "Cancelled." (one message for another), and a late query while a retry
    // runs (it only swaps the spinner's query text).
    case "ConnectSucceeds":
      return "the host connects";
    case "ConnectFails":
      return from.screen === "error" || from.screen === "cancelled" ? null : "the connect fails";
    case "HostContextChanged":
      return "the host names the tool";
    case "HostToolInput":
      return from.screen === "loading" && from.by === "retry" ? null : "the host sends the query";
    case "HostToolResult":
      return to.screen === "answer" ? "the result arrives" : "the query fails";
    case "HostToolCancelled":
      return "the host cancels";
    case "UserRetries":
      return "you press Try again";
    case "RetryReturns":
      return to.screen === "answer" ? "the retry returns rows" : "the retry fails";
    default:
      return null;
  }
};
