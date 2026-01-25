import React, { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { MsgTypes, type StrokeMsg, type Point } from "@inlko/shared";

type Props = {
  roomId: string;
  send: (type: string, payload: any, roomId?: string) => void;
  incomingStroke?: { userId?: string; type: string; payload: any } | null;
  width?: number;
  height?: number;
};

type Stroke = StrokeMsg & { userId?: string };

function normPoint(x: number, y: number, rect: DOMRect): Point {
  const nx = Math.min(1, Math.max(0, (x - rect.left) / rect.width));
  const ny = Math.min(1, Math.max(0, (y - rect.top) / rect.height));
  return { x: nx, y: ny, t: Date.now() };
}

export function WhiteboardCanvas({ roomId, send, incomingStroke, width = 800, height = 500 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [activeStrokeId, setActiveStrokeId] = useState<string | null>(null);

  const style = useMemo(
    () => ({ tool: "pen" as const, color: "#111111", width: 0.004, opacity: 1 }),
    []
  );

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
      ctx.moveTo(pts[0].x * canvas.width, pts[0].y * canvas.height);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x * canvas.width, pts[i].y * canvas.height);
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
    const move: StrokeMsg = { strokeId: activeStrokeId, style, points: [p] };

    send(MsgTypes.WbStrokeMove, move, roomId);
  }

  function endStroke() {
    if (!activeStrokeId) return;
    const end: StrokeMsg = { strokeId: activeStrokeId, style, points: [] };
    send(MsgTypes.WbStrokeEnd, end, roomId);
    setActiveStrokeId(null);
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button onClick={() => send(MsgTypes.WbClear, {}, roomId)}>Clear</button>
        <div className="small">Tip: draw here with mouse/touch. Mobile companion will draw here too.</div>
      </div>
      <div className="canvasWrap">
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          onPointerDown={startStroke}
          onPointerMove={moveStroke}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          style={{ display: "block", touchAction: "none", width: "100%", height: "auto" }}
        />
      </div>
    </div>
  );
}
