import { useMemo, useState, useRef, useEffect } from "react";
import { nanoid } from "nanoid";
import { QRCodeCanvas } from "qrcode.react";
import { MsgTypes, WS_VERSION, type WsEnvelope } from "@inlko/shared";
import { WsClient } from "../../shared/wsClient";
import { WhiteboardCanvas } from "../whiteboard/WhiteboardCanvas";
import { useWebRtc } from "./useWebRtc";

const REALTIME_URL =
  /*import.meta.env.VITE_REALTIME_URL ?? "ws://localhost:8080"*/
  (import.meta.env.VITE_REALTIME_URL ?? "ws://inklo.onrender.com/").replace(
    /\/+$/,
    "",
  );

export function App() {
  const [roomId, setRoomId] = useState(() => nanoid(8));
  const [connected, setConnected] = useState(false);
  const [userId, setUserId] = useState<string | undefined>();
  const [pairToken, setPairToken] = useState<string | null>(null);
  const [pairStatus, setPairStatus] = useState<string>("Not paired");
  const [incoming, setIncoming] = useState<any>(null);
  const [pendingPairCreate, setPendingPairCreate] = useState(false);
  const [history, setHistory] = useState({
    canUndo: false,
    canRedo: false,
    undoCount: 0,
    redoCount: 0,
  });
  const [peers, setPeers] = useState<string[]>([]);
  const [joinMic, setJoinMic] = useState(true);
  const [joinCam, setJoinCam] = useState(true);
  const [sharing, setSharing] = useState(false);

  const { send, wsClient } = useMemo(() => {
    const c = new WsClient({
      url: `${REALTIME_URL}?role=web`,
      onStatus: (status) => setConnected(status === "open"),
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
        if (msg?.type === MsgTypes.RtcPeers) {
          const list = (msg.payload?.peers ?? []) as string[];
          setPeers(list);
          handlePeers(list);
        }
        if (msg?.type === MsgTypes.RtcPeerJoined) {
          const pid = msg.payload?.userId as string;
          setPeers((prev) => (prev.includes(pid) ? prev : [...prev, pid]));
          handlePeerJoined(pid);
        }
        if (msg?.type === MsgTypes.RtcPeerLeft) {
          const pid = msg.payload?.userId as string;
          setPeers((prev) => prev.filter((x) => x !== pid));
          handlePeerLeft(pid);
        }
        if (
          msg?.type === MsgTypes.RtcOffer ||
          msg?.type === MsgTypes.RtcAnswer ||
          msg?.type === MsgTypes.RtcIce
        ) {
          handleSignal(msg);
        }
        if (msg?.type === MsgTypes.JoinedRoom) {
          setUserId(msg.userId);
          send(MsgTypes.WbSnapshotRequest, {}, roomId);
          if (pendingPairCreate) {
            send(MsgTypes.PairCreate, {}, roomId);
          }
        }
      },
    });
    const send = <T,>(
      type: string,
      payload: T,
      roomId?: string,
      requestId?: string,
    ) => {
      const env: WsEnvelope<T> = {
        v: WS_VERSION,
        type,
        roomId,
        requestId,
        payload,
      };
      c.send(env);
    };
    return { send, wsClient: c };
  }, [roomId, pendingPairCreate]);

  useEffect(() => {
    wsClient.connect();
    return () => {
      wsClient.close();
    };
  }, [wsClient]);

  const {
    localStream,
    remoteStreams,
    peerStatus,
    micEnabled,
    camEnabled,
    startMedia,
    stopMedia,
    startScreenShare,
    stopScreenShare,
    toggleMic,
    toggleCam,
    handlePeers,
    handlePeerJoined,
    handlePeerLeft,
    handleSignal,
    closeAll,
  } = useWebRtc({ roomId, localUserId: userId, send });

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
      <h2>inlko (MVP) ? Web Whiteboard + Mobile Companion</h2>

      <div className="row">
        <div className="card" style={{ minWidth: 320 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              placeholder="Room ID"
            />
            <button onClick={joinRoom}>
              {connected ? "Join room" : "Connecting..."}
            </button>
          </div>

          <div className="small" style={{ marginTop: 8 }}>
            Web userId: {userId ?? "?"}
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
              <div
                style={{
                  background: "white",
                  padding: 8,
                  display: "inline-block",
                  borderRadius: 8,
                }}
              >
                <QRCodeCanvas value={qrValue} size={220} />
              </div>
              <div className="small" style={{ marginTop: 8 }}>
                Token expires quickly. If it fails, generate a new one.
              </div>
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 340 }}>
          <div className="card" style={{ marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>Call</h3>

            <div
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                flexWrap: "wrap",
                marginBottom: 10,
              }}
            >
              <label
                className="small"
                style={{ display: "flex", gap: 6, alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={joinMic}
                  onChange={(e) => setJoinMic(e.target.checked)}
                />
                Start with mic
              </label>

              <label
                className="small"
                style={{ display: "flex", gap: 6, alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={joinCam}
                  onChange={(e) => setJoinCam(e.target.checked)}
                />
                Start with camera
              </label>

              <button
                onClick={async () => {
                  try {
                    await startMedia({ audio: joinMic, video: joinCam });
                  } catch (err: any) {
                    console.error("startMedia failed", err);
                    const name = err?.name ?? "";
                    const msg = err?.message ?? "";

                    if (
                      name === "NotReadableError" ||
                      /device.*in use/i.test(msg)
                    ) {
                      alert(
                        "Camera/mic is already in use by another tab/app. Close the other tab or start this tab with camera/mic off.",
                      );
                      return;
                    }

                    if (name === "NotAllowedError") {
                      alert(
                        "Permission denied. Allow camera/mic access in the browser prompt.",
                      );
                      return;
                    }

                    alert(`Could not start media: ${name} ${msg}`);
                  }
                }}
                disabled={!connected}
              >
                Start
              </button>

              <button onClick={toggleMic} disabled={!localStream}>
                {micEnabled ? "Mute" : "Unmute"}
              </button>

              <button onClick={toggleCam} disabled={!localStream}>
                {camEnabled ? "Camera off" : "Camera on"}
              </button>

              <button
                onClick={async () => {
                  if (!localStream) return;
                  try {
                    if (!sharing) {
                      await startScreenShare();
                      setSharing(true);
                    } else {
                      await stopScreenShare();
                      setSharing(false);
                    }
                  } catch {
                    alert("Screen share failed.");
                  }
                }}
                disabled={!localStream}
              >
                {sharing ? "Stop share" : "Share screen"}
              </button>

              <button
                onClick={() => {
                  setSharing(false);
                  stopMedia();
                  closeAll();
                }}
              >
                Hang up
              </button>
            </div>

            <div className="small" style={{ marginTop: 6 }}>
              <div>
                <b>You:</b> {userId ?? "?"}
              </div>
              <div>
                <b>Participants:</b> {1 + peers.length}
              </div>
              <div style={{ marginTop: 6 }}>
                {peers.length === 0 ? (
                  <div>No other participants yet.</div>
                ) : (
                  peers.map((pid) => (
                    <div key={pid} style={{ display: "flex", gap: 8 }}>
                      <span>{pid}</span>
                      <span>?</span>
                      <span>{peerStatus[pid] ?? "new"}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <VideoGrid
              localStream={localStream}
              remoteStreams={remoteStreams}
            />
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Whiteboard</h3>
            <WhiteboardCanvas
              roomId={roomId}
              send={send}
              incomingStroke={incoming}
              history={history}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function VideoTile({
  stream,
  label,
  muted,
}: {
  stream: MediaStream;
  label: string;
  muted?: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.srcObject = stream;
  }, [stream]);

  return (
    <div style={{ width: 240 }}>
      <div className="small" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={!!muted}
        style={{
          width: "100%",
          borderRadius: 10,
          border: "1px solid #ddd",
          background: "#000",
        }}
      />
    </div>
  );
}

function VideoGrid({
  localStream,
  remoteStreams,
}: {
  localStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>;
}) {
  const remoteEntries = Object.entries(remoteStreams);

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {localStream ? (
        <VideoTile stream={localStream} label="You" muted />
      ) : (
        <div className="small">No local media yet.</div>
      )}
      {remoteEntries.map(([userId, stream]) => (
        <VideoTile key={userId} stream={stream} label={`Peer ${userId}`} />
      ))}
    </div>
  );
}
