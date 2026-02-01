import React, { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { MsgTypes, type StrokeMsg, type Point } from "@inlko/shared";

type Props = {
  roomId: string;
  send: (type: string, payload: any, roomId?: string) => void;
  incomingStroke?: { userId?: string; type: string; payload: any } | null;
  history: { canUndo: boolean; canRedo: boolean; undoCount: number; redoCount: number };
  width?: number;
  height?: number;
};

type Stroke = StrokeMsg & { userId?: string };

function normPoint(x: number, y: number, rect: DOMRect): Point {
  const nx = Math.min(1, Math.max(0, (x - rect.left) / rect.width));
  const ny = Math.min(1, Math.max(0, (y - rect.top) / rect.height));
  return { x: nx, y: ny, t: Date.now() };
}

function colorFromUserId(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 80% 45%)`;
}

export function WhiteboardCanvas({ roomId, send, incomingStroke, history, width = 800, height = 500 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [activeStrokeId, setActiveStrokeId] = useState<string | null>(null);
  const [cursors, setCursors] = useState<Record<string, { x: number; y: number; t: number }>>({});
  const pointBufferRef = useRef<Point[]>([]);
  const flushRafRef = useRef<number | null>(null);

  const style = useMemo(
    () => ({ tool: "pen" as const, color: "#111111", width: 0.004, opacity: 1 }),
    []
  );

  function flushPoints() {
    if (!activeStrokeId) return;
    const pts = pointBufferRef.current;
    if (pts.length === 0) return;

    const chunk = pts.splice(0, pts.length);
    const move: StrokeMsg = { strokeId: activeStrokeId, style, points: chunk };
    send(MsgTypes.WbStrokeMove, move, roomId);
  }

  function scheduleFlush() {
    if (flushRafRef.current != null) return;
    flushRafRef.current = requestAnimationFrame(() => {
      flushRafRef.current = null;
      flushPoints();
    });
  }

  // Render all strokes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const s of strokes) {
      const isEraser = s.style.tool === "eraser";
      ctx.globalCompositeOperation = isEraser ? "destination-out" : "source-over";
      ctx.globalAlpha = s.style.opacity;

      const pxWidth = Math.max(1, s.style.width * canvas.width);
      ctx.lineWidth = pxWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = s.style.color;

      const pts = s.points;
      if (pts.length < 2) continue;

      ctx.beginPath();

      const p0x = pts[0].x * canvas.width;
      const p0y = pts[0].y * canvas.height;
      ctx.moveTo(p0x, p0y);

      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const curr = pts[i];

        const prevX = prev.x * canvas.width;
        const prevY = prev.y * canvas.height;
        const currX = curr.x * canvas.width;
        const currY = curr.y * canvas.height;

        const midX = (prevX + currX) / 2;
        const midY = (prevY + currY) / 2;

        ctx.quadraticCurveTo(prevX, prevY, midX, midY);
      }

      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }, [strokes]);

  // Apply incoming events
  useEffect(() => {
    if (!incomingStroke) return;
    const { type, payload, userId } = incomingStroke;

    if (type === MsgTypes.WbSnapshot) {
      const strokesFromServer = (payload?.strokes ?? []) as Stroke[];
      setStrokes(strokesFromServer);
      return;
    }

    if (type === MsgTypes.WbStrokeRemove) {
      const strokeId = payload?.strokeId as string;
      if (!strokeId) return;
      setStrokes((prev) => prev.filter((s) => s.strokeId !== strokeId));
      return;
    }

    if (type === MsgTypes.WbStrokeRestore) {
      const stroke = payload?.stroke as any;
      if (!stroke?.strokeId) return;

      setStrokes((prev) => {
        const exists = prev.some((s) => s.strokeId === stroke.strokeId);
        return exists ? prev : [...prev, stroke];
      });
      return;
    }

    if (type === MsgTypes.CursorMove) {
      const x = Number(payload?.x);
      const y = Number(payload?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;

      setCursors((prev) => ({
        ...prev,
        [incomingStroke.userId ?? "unknown"]: { x, y, t: Date.now() }
      }));
      return;
    }

    if (type === MsgTypes.WbClear) {
      setStrokes([]);
      return;
    }

    if (
      type === MsgTypes.WbStrokeStart ||
      type === MsgTypes.WbStrokeMove ||
      type === MsgTypes.WbStrokeEnd
    ) {
      const msg = payload as StrokeMsg;

      setStrokes((prev) => {
        const idx = prev.findIndex((s) => s.strokeId === msg.strokeId);
        if (idx === -1) {
          return [...prev, { ...msg, userId }];
        }
        const copy = prev.slice();
        const existing = copy[idx];
        copy[idx] = { ...existing, ...msg, points: [...existing.points, ...msg.points] };
        return copy;
      });
    }
  }, [incomingStroke]);

  function startStroke(ev: React.PointerEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    const strokeId = nanoid(10);
    setActiveStrokeId(strokeId);

    const p = normPoint(ev.clientX, ev.clientY, rect);
    const start: StrokeMsg = { strokeId, style, points: [p] };

    send(MsgTypes.WbStrokeStart, start, roomId);
  }

  function moveStroke(ev: React.PointerEvent) {
    if (!activeStrokeId) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    const p = normPoint(ev.clientX, ev.clientY, rect);
    pointBufferRef.current.push(p);
    scheduleFlush();
  }

  function sendCursor(ev: React.PointerEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const p = normPoint(ev.clientX, ev.clientY, rect);
    send(MsgTypes.CursorMove, { x: p.x, y: p.y, isDrawing: !!activeStrokeId }, roomId);
  }

  function endStroke() {
    if (!activeStrokeId) return;
    flushPoints();
    const end: StrokeMsg = { strokeId: activeStrokeId, style, points: [] };
    send(MsgTypes.WbStrokeEnd, end, roomId);
    setActiveStrokeId(null);
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <button disabled={!history.canUndo} onClick={() => send(MsgTypes.WbUndo, {}, roomId)}>
          Undo ({history.undoCount})
        </button>
        <button disabled={!history.canRedo} onClick={() => send(MsgTypes.WbRedo, {}, roomId)}>
          Redo ({history.redoCount})
        </button>
        <button onClick={() => send(MsgTypes.WbClear, {}, roomId)}>Clear</button>
        <div className="small">Undo/Redo affects only your strokes.</div>
      </div>
      <div className="canvasWrap" style={{ position: "relative" }}>
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          onPointerDown={startStroke}
          onPointerMove={(e) => {
            moveStroke(e);
            sendCursor(e);
          }}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          style={{ display: "block", touchAction: "none", width: "100%", height: "auto" }}
        />
        {Object.entries(cursors).map(([uid, c]) => {
          if (Date.now() - c.t > 3000) return null;

          return (
            <div
              key={uid}
              style={{
                position: "absolute",
                left: c.x * width - 4,
                top: c.y * height - 4,
                width: 8,
                height: 8,
                borderRadius: 999,
                background: colorFromUserId(uid),
                pointerEvents: "none",
              }}
              title={uid}
            />
          );
        })}
      </div>
    </div>
  );
}
