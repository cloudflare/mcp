import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useAgent } from "agents/react";
import type { GridState } from "@/server";

const DECAY_MS = 60_000; // must match server
const FADE_START = 0.5; // start fading at 50% of lifetime remaining

interface MultiplayerGridProps {
  gridDensity: number;
  canvasWidth: number;
  canvasHeight: number;
}

export function MultiplayerGrid({
  gridDensity,
  canvasWidth,
  canvasHeight,
}: MultiplayerGridProps) {
  const [cells, setCells] = useState<Record<string, number>>({});
  const [connected, setConnected] = useState(false);
  const [, setTick] = useState(0);
  const optimisticRef = useRef<Set<string>>(new Set());

  // Match the shader grid formula exactly (see EffectLayer in index.tsx)
  const { gridCols, gridRows } = useMemo(() => {
    if (canvasWidth === 0 || canvasHeight === 0)
      return { gridCols: 0, gridRows: 0 };
    const aspect = canvasWidth / canvasHeight;
    return {
      gridCols:
        aspect >= 1
          ? Math.round(gridDensity * aspect)
          : gridDensity,
      gridRows:
        aspect >= 1
          ? gridDensity
          : Math.round(gridDensity / aspect),
    };
  }, [gridDensity, canvasWidth, canvasHeight]);

  const agent = useAgent<GridState>({
    agent: "GridAgent",
    name: "default",
    onStateUpdate: (state) => {
      setCells(state.cells ?? {});
      optimisticRef.current.clear();
    },
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
  });

  // Tick every second to update fade opacity
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!connected || gridCols === 0 || gridRows === 0) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const col = Math.floor((x / canvasWidth) * gridCols);
      const row = Math.floor((y / canvasHeight) * gridRows);

      if (col < 0 || col >= gridCols || row < 0 || row >= gridRows) return;

      const key = `${row},${col}`;

      optimisticRef.current.add(key);
      setCells((prev) => {
        const next = { ...prev };
        if (next[key]) {
          delete next[key];
        } else {
          next[key] = Date.now();
        }
        return next;
      });

      agent.stub.toggleCell(key);
    },
    [connected, canvasWidth, canvasHeight, gridCols, gridRows, agent]
  );

  if (canvasWidth === 0 || canvasHeight === 0 || gridCols === 0) return null;

  const cellW = canvasWidth / gridCols;
  const cellH = canvasHeight / gridRows;
  const now = Date.now();

  return (
    <div
      className="absolute inset-0 cursor-crosshair"
      style={{ width: canvasWidth, height: canvasHeight }}
      onClick={handleClick}
    >
      {Object.keys(cells).map((key) => {
        const timestamp = cells[key];
        if (!timestamp) return null;

        const age = now - timestamp;
        const remaining = Math.max(0, 1 - age / DECAY_MS);

        const fadeProgress =
          remaining < FADE_START ? remaining / FADE_START : 1;
        const opacity = 0.12 * fadeProgress;

        if (opacity <= 0) return null;

        const [row, col] = key.split(",").map(Number);
        return (
          <div
            key={key}
            className="absolute rounded-xs"
            style={{
              left: col * cellW,
              top: row * cellH,
              width: cellW - 1,
              height: cellH - 1,
              backgroundColor: "currentColor",
              opacity,
              pointerEvents: "none",
              transition: "opacity 1s linear",
            }}
          />
        );
      })}
    </div>
  );
}
