// The view for Chart.cfg: labels.mjs, with steps hidden to keep the chart
// readable (SKILL.md lists them): opening another entry when no read runs in
// the editor, leaving fullscreen from anything but an idle agent step or a
// running read, a background read failing (a toast), and picking a table
// while another read is already going on.
import { step as label, where } from "./labels.mjs";
export { title, state, group, colors } from "./labels.mjs";
const busy = (v) => v.mRun.st === "running" || Object.keys(v.bg ?? {}).length > 0;
export const step = (action, from, to) => {
  const idle = from.display === "fullscreen" && from.mRun.st !== "running";
  if (action === "YouOpen" && idle) return null;
  if (action === "YouLeaveFullscreen" && idle && where(from) !== "Viewing an agent step") return null;
  if (action === "BgFails") return null;
  if (action === "YouPick" && busy(from)) return null;
  if (action === "YouRun" && where(from) !== "Viewing an agent step" && Object.keys(from.bg ?? {}).length > 0) return null;
  return label(action, from, to);
};
