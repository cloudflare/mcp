// The reader's words for the D1 Studio answer card's run / send-to-chat flow.
// Read by /statechart (--view). Depends only on its arguments.

export const title = "D1 Studio answer card: Run a read, or send a write to the chat";

// The post of the send the card is on (Sending / not confirmed), else 0. Mirrors LivePost in CardRunSend.tla.
const livePost = (v) => {
  const run = v.card.run;
  if (run.status !== "sending" && run.status !== "unconfirmed") return 0;
  const t = v.postOf.find((p) => p.id === run.id);
  return t ? t.post : 0;
};

// A write the chat has that the card never showed as Sent nor said it couldn't confirm, and is no longer on
// (ChatGotItCardSaysSo broken).
const lostConfirmation = (v) =>
  v.chatGot.some(
    (p) => !v.shownSent.includes(p) && !v.toldUnsure.includes(p) && p !== livePost(v),
  );

export const state = (v) => {
  switch (v.card.run.status) {
    case "idle":
      return lostConfirmation(v) ? "Editing (the chat has a write the card never confirmed)" : "Editing";
    case "running":
      return "Running the read";
    case "sending":
      return v.sameDraftPosts.length > 1 ? "Sending the same write again" : "Sending to chat";
    case "unconfirmed":
      return "Waiting on host (Copy SQL offered)";
    case "sent":
      return "Sent";
    case "refused":
      return lostConfirmation(v)
        ? "Refused (but the chat has an earlier copy)"
        : "Refused by host (Copy SQL offered)";
    case "failed":
      return "Host error";
  }
  return v.card.run.status;
};

export const group = (v) => {
  const s = v.card.run.status;
  if (s === "idle") return "editing";
  if (s === "running" || s === "sending") return "busy";
  if (s === "unconfirmed" || s === "refused") return "copy";
  if (s === "sent") return "done";
  return "error";
};

export const colors = { editing: "blue", busy: "yellow", copy: "orange", done: "teal", error: "pink" };

// Every step is labeled (a step can sit on a bug path); none is hidden.
export const step = (action, from, to) => {
  switch (action) {
    case "YouOpenOrFoldEditor":
      return "you open or fold the editor";
    case "YouType":
    case "YouTypeADraft":
      return "you edit the SQL";
    case "YouPressCmdEnter":
      return "you press ⌘↵ in the editor";
    case "YouClickRunOrSend":
      return to.card.run.status === "sending" ? "you click Send to chat" : "you click Run";
    case "YouUseFix":
      return "you click the fix (Use …)";
    case "YouPageLimit":
      return "you page the query's LIMIT";
    case "YouRevert":
      return "you click Revert";
    case "YouGoFullscreen":
      return "you go fullscreen";
    case "YouLeaveFullscreen":
      return "you come back from fullscreen";
    case "HostAnswersRead":
      return "D1 answers the read";
    case "HostFailsARead":
      return "the host fails the read";
    case "HostTakesASend":
      return "the chat takes it and the host confirms";
    case "HostTakesASendSilently":
      return "the chat takes it; no answer reaches the card";
    case "HostRefusesASend":
      return "the host refuses the message";
    case "ASendTimerFires":
      return "5 seconds pass with no answer";
  }
  return action;
};
