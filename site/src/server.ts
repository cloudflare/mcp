import { Agent, routeAgentRequest, callable } from "agents";

// Values are epoch-ms timestamps of when the cell was toggled on
export type GridState = {
  cells: Record<string, number>;
};

const MAX_COORD = 200; // generous upper bound for any aspect ratio
const MAX_CELLS = 500;
const DECAY_MS = 60_000; // cells live for 60 seconds
const SWEEP_INTERVAL_S = 5; // run decay sweep every 5 seconds

export class GridAgent extends Agent<Env, GridState> {
  initialState: GridState = { cells: {} };

  async onStart() {
    // Ensure a single recurring decay sweep is scheduled
    const schedules = this.getSchedules();
    const hasDecay = schedules.some((s) => s.callback === "decayCells");
    if (!hasDecay) {
      await this.scheduleEvery(SWEEP_INTERVAL_S, "decayCells", {});
    }
  }

  async decayCells() {
    const now = Date.now();
    const cells = { ...this.state.cells };
    let changed = false;
    for (const key of Object.keys(cells)) {
      if (now - cells[key] > DECAY_MS) {
        delete cells[key];
        changed = true;
      }
    }
    if (changed) {
      this.setState({ cells });
    }
  }

  @callable()
  toggleCell(key: string) {
    // Validate key format "row,col"
    const parts = key.split(",");
    if (parts.length !== 2) return;
    const row = Number.parseInt(parts[0], 10);
    const col = Number.parseInt(parts[1], 10);
    if (
      Number.isNaN(row) ||
      Number.isNaN(col) ||
      row < 0 ||
      row >= MAX_COORD ||
      col < 0 ||
      col >= MAX_COORD
    )
      return;

    const cells = { ...this.state.cells };
    if (cells[key]) {
      delete cells[key];
    } else {
      // Enforce max cell limit
      if (Object.keys(cells).length >= MAX_CELLS) return;
      cells[key] = Date.now();
    }
    this.setState({ cells });
  }

  @callable()
  clearGrid() {
    this.setState({ cells: {} });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
