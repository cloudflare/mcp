// Shared by view.mjs and chart-view.mjs: the reader's words for states and steps.
const len = (seq) => Object.keys(seq ?? {}).length;
const list = (set) => Object.values(set ?? {});
export const title = "D1 Studio: the fullscreen console and display modes";
export const where = (v) => {
  if (v.display === "inline") return "Inline card";
  const e = v.entries[v.active];
  if (e.who === "agent") return e.ranAt ? "Viewing an agent step read again here" : "Viewing an agent step";
  return "Your query in history";
};
export const state = (v) => {
  const w = where(v);
  const parts = [];
  if (v.display === "fullscreen" && v.mRun.st === "running") parts.push("running here");
  // Only where it can change what that screen means: an agent step a read you left can mark.
  if (list(v.bg).length && w !== "Your query in history") parts.push("a read in the background");
  return parts.length ? `${w}, ${parts.join(", ")}` : w;
};
export const group = (v) => (v.display === "inline" ? "inline" : v.mRun.st === "running" ? "busy" : "console");
export const colors = { inline: "tan", console: "blue", busy: "orange" };
const gone = (from, to) => list(from.bg).find((b) => !list(to.bg).some((c) => c.rid === b.rid));
export const step = (action, from, to) => {
  switch (action) {
    case "YouGoFullscreen": return "you open fullscreen";
    case "YouLeaveFullscreen": return "you leave fullscreen";
    case "YouRun": return to.mRun.sql === "mine" ? "you run your own SQL" : "you run its SQL unchanged";
    case "YouPick": return "you pick a table";
    case "MainLands":
      return len(to.entries) === len(from.entries) ? "the read lands [SQL unchanged]" : "the read lands";
    case "MainFails": return "the host can't run the read";
    case "BgLands": {
      const b = gone(from, to);
      if (b && b.kind === "pick") return "the picked table's rows land and open";
      return b && b.sameAs ? "a read you left lands, marking its step" : "a read you left lands";
    }
    case "BgFails": return "a read in the background fails (a toast says so)";
    case "YouOpen": return "you open another entry";
    default: return action;
  }
};
