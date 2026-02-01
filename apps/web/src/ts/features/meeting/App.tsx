import React, { useMemo, useState } from "react";
import { nanoid } from "nanoid";
import { QRCodeCanvas } from "qrcode.react";
import { MsgTypes } from "@inlko/shared";
import { createWs } from "../../shared/wsClient";
import { WhiteboardCanvas } from "../whiteboard/WhiteboardCanvas";

const REALTIME_URL = "ws://localhost:8080";

export function App() {
  const [roomId, setRoomId] = useState(() => nanoid(8));
  const [connected, setConnected] = useState(false);
  const [userId, setUserId] = useState<string | undefined>();
  const [pairToken, setPairToken] = useState<string | null>(null);
  const [pairStatus, setPairStatus] = useState<string>("Not paired");
  const [incoming, setIncoming] = useState<any>(null);
  const [pendingPairCreate, setPendingPairCreate] = useState(false);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 });

  const { send } = useMemo(() => {
    const c = createWs(`${REALTIME_URL}?role=web`, {
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onMessage: (msg) => {
        if (msg?.type === "hello") setUserId(msg?.payload?.userId);

        if (msg?.type === MsgTypes.PairCreated) {
          setPairToken(msg.payload.pairToken);
          setPendingPairCreate(false);
        }
        if (msg?.type === MsgTypes.PairSuccess) {
          setPairStatus(`Paired with mobile: ${msg.payload.mobileUserId}`);
        }
        if (msg?.type?.startsWith("wb.")) {
          setIncoming(msg);
        }
        if (msg?.type === MsgTypes.WbHistory) {
          setHistory(msg.payload);
        }
        if (msg?.type === MsgTypes.JoinedRoom) {
          send(MsgTypes.WbSnapshotRequest, {}, roomId);
          if (pendingPairCreate) {
            send(MsgTypes.PairCreate, {}, roomId);
          }
        }
      }
    });
    return c;
  }, [roomId, pendingPairCreate]);

  function joinRoom() {
    send(MsgTypes.JoinRoom, { roomId });
    setPairToken(null);
    setPairStatus("Not paired");
  }

  function createPairToken() {
    // Ensure we're in the room before requesting a pairing token.
    if (!connected) return;
    setPendingPairCreate(true);
    send(MsgTypes.JoinRoom, { roomId });
  }

  // QR payload: keep it simple for now: just token text.
  // Mobile will scan token and then join the same roomId (entered or embedded later).
  // For v1 we embed roomId too:
  const qrValue = pairToken ? JSON.stringify({ roomId, pairToken }) : "";

  return (
    <div className="container">
      <h2>inlko (MVP) — Web Whiteboard + Mobile Companion</h2>

      <div className="row">
        <div className="card" style={{ minWidth: 320 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input value={roomId} onChange={(e) => setRoomId(e.target.value)} placeholder="Room ID" />
            <button onClick={joinRoom}>{connected ? "Join room" : "Connecting..."}</button>
          </div>

          <div className="small" style={{ marginTop: 8 }}>
            Web userId: {userId ?? "…"}
          </div>

          <hr />

          <button onClick={createPairToken} disabled={!connected}>
            Create pairing QR
          </button>

          <div className="small" style={{ marginTop: 8 }}>
            Pair status: {pairStatus}
          </div>

          {pairToken && (
            <div style={{ marginTop: 12 }}>
              <div className="small">Scan this QR in the mobile app:</div>
              <div style={{ background: "white", padding: 8, display: "inline-block", borderRadius: 8 }}>
                <QRCodeCanvas value={qrValue} size={220} />
              </div>
              <div className="small" style={{ marginTop: 8 }}>
                Token expires quickly. If it fails, generate a new one.
              </div>
            </div>
          )}
        </div>

        <div className="card" style={{ flex: 1, minWidth: 340 }}>
          <h3 style={{ marginTop: 0 }}>Whiteboard</h3>
          <WhiteboardCanvas roomId={roomId} send={send} incomingStroke={incoming} history={history} />
        </div>
      </div>
    </div>
  );
}

