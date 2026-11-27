// Reader's words for the D1 Studio copy model (D1Copy.tla). `mark` mirrors Trio's `marked`.
const ids = (v) => Object.keys(v.cp).map(Number).filter((i) => i <= v.n);
const settled = (c) => c.write === "written" || c.write === "failed";
const marked = (v) =>
  Object.keys(v.local).some((t) => {
    const k = v.toast.kind;
    if (k === "busy" || k === "failed") return false;
    const c = v.cp[v.toast.of];
    if (k === "copied" && c && (c.kind === "rows" || c.kind === "all") && c.src === t) return true;
    return v.local[t].st === "copied";
  });
const toastWords = (v) => {
  const k = v.toast.kind;
  if (k === "none") return "No toast";
  if (k === "busy") return v.cp[v.toast.of].read === "hung" ? "Reading rows…, D1 never answers" : "Reading rows…";
  const c = v.cp[v.toast.of];
  const stale = ids(v).some((j) => j > v.toast.of && settled(v.cp[j]));
  const what =
    k === "failed"
      ? c.kind === "all" && c.read === "failed"
        ? "D1 didn’t read the rest"
        : "Clipboard blocked"
      : c.kind === "all"
        ? "Copied all"
        : c.kind === "sql"
          ? "Copied the SQL"
          : "Copied the held rows";
  return stale ? `${what}, about an older copy` : what;
};
const inFlight = (v) => ids(v).some((i) => v.cp[i].kind === "all" && !settled(v.cp[i]));
const clipStale = (v) => {
  const ok = ids(v).filter((i) => v.cp[i].write === "written");
  return v.clip !== 0 && v.clip !== Math.max(...ok);
};
export const state = (v) =>
  [
    toastWords(v),
    marked(v) ? "✓ on" : null,
    inFlight(v) && v.toast.kind !== "busy"
      ? ids(v).some((i) => i < v.n && v.cp[i].kind === "all" && !settled(v.cp[i]))
        ? "a superseded Copy all still pending"
        : "Copy all still running"
      : null,
    clipStale(v) ? "clipboard holds an older copy" : null
  ]
    .filter(Boolean)
    .join(", ");
export const step = (action, from, to) => {
  const c = to.just ? to.cp[to.just] : null;
  // Copying again once a Copy all has ended repeats the first arrows: not drawn.
  const ended = !inFlight(from) && (from.toast.kind === "failed" || (from.toast.kind === "copied" && from.cp[from.toast.of].kind === "all"));
  const calm =
    ids(to).every((i) => settled(to.cp[i])) && !ids(to).some((j) => j > to.toast.of && settled(to.cp[j]));
  if ((action === "HostWrites" || action === "FallbackCopies") && c && c.kind === "rows" && ended && calm && to.toast.of === to.just)
    return null;
  switch (action) {
    case "YouCopyRows": return "you copy rows";
    case "YouCopyAll": return "you press Copy all";
    case "YouCopySql": return "you copy the SQL";
    case "D1Answers": return "D1 returns the rest";
    case "D1Fails": return "D1 fails";
    case "D1Hangs": return "D1 stops answering";
    case "SdkTimesOut": return "the read times out after 35 s";
    case "HostWrites":
    case "FallbackCopies":
      return c && c.kind === "all" ? "the Copy all write lands" : "the copy lands";
    case "HostRefuses": return "the sandbox refuses the write";
    case "ItemRejects":
      return to.just < to.n ? "the superseded Copy all gives up" : "the Copy all write fails with the read";
    case "FallbackFails": return "the copy fails";
    case "ToastHides": return "the toast hides";
    case "TrioResets": return "the ✓ times out";
    case "SqlResets": return "Copy SQL resets";
    case "AllQuiet": return null;
    default: return action;
  }
};
export const group = (v) => (v.toast.kind === "busy" ? "busy" : v.toast.kind === "failed" ? "failed" : "rest");
export const colors = { busy: "yellow", failed: "orange", rest: "blue" };
export const title = "D1 Studio copy: the one toast, the trio check marks, Copy all";
