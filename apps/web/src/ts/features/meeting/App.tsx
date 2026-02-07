import { useState, useRef, useEffect, useCallback } from "react";
import { nanoid } from "nanoid";
import { QRCodeCanvas } from "qrcode.react";
import { MsgTypes, WS_VERSION, type WsEnvelope, type ChatMessagePayload } from "@inlko/shared";
import { WsClient } from "../../shared/wsClient";
import { WhiteboardCanvas } from "../whiteboard/WhiteboardCanvas";
import { useWebRtc } from "./useWebRtc";

const REALTIME_URL = import.meta.env.VITE_REALTIME_URL;
/*import.meta.env.VITE_REALTIME_URL ?? "ws://localhost:8080"*/
//import.meta.env.VITE_REALTIME_URL ?? "ws://https://inklo.onrender.com/"
// (import.meta.env.VITE_REALTIME_URL ?? "ws://localhost:8080").replace(
// /\/+$/,
// "",
//);

export function App() {
  const [roomId, setRoomId] = useState(() => nanoid(8));
  const [connected, setConnected] = useState(false);
  const [userId, setUserId] = useState<string | undefined>();
  const [pairToken, setPairToken] = useState<string | null>(null);
  const [pairStatus, setPairStatus] = useState<string>("Not paired");
  const [incoming, setIncoming] = useState<WsEnvelope<unknown> | null>(null);
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
  const [handRaised, setHandRaised] = useState(false);
  const [view, setView] = useState<"home" | "meeting">("home");
  const [showStartModal, setShowStartModal] = useState(false);
  const [startAction, setStartAction] = useState<"create" | "join">("create");
  const [homeRoomId, setHomeRoomId] = useState("");
  const [participantName, setParticipantName] = useState("");
  const [pendingName, setPendingName] = useState("");
  const [startMicChoice, setStartMicChoice] = useState(true);
  const [startCamChoice, setStartCamChoice] = useState(true);
  const [showPairing, setShowPairing] = useState(false);
  const [lastJoinedRoomId, setLastJoinedRoomId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessagePayload[]>([]);
  const [chatUnread, setChatUnread] = useState(0);
  const chatOpenRef = useRef(false);
  const pendingChatIdsRef = useRef(new Set<string>());
  const roomIdRef = useRef(roomId);
  const viewRef = useRef(view);
  const handleMessageRef = useRef<(msg: WsEnvelope<unknown>) => void>(() => {});
  const wsClientRef = useRef<WsClient | null>(null);
  const autoStartMediaRef = useRef(false);
  const autoStartDoneRef = useRef(false);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    chatOpenRef.current = chatOpen;
  }, [chatOpen]);

  // First, get the handlers from useWebRtc but with a temporary send
  const { handlePeers, handlePeerJoined, handlePeerLeft, handleSignal } =
    useWebRtc({ roomId, localUserId: userId, send: () => {} });

  const handleMessage = useCallback(
    (msg: WsEnvelope<unknown>) => {
      if (msg?.type === "hello")
        setUserId((msg?.payload as { userId?: string })?.userId);

      if (msg?.type === MsgTypes.PairCreated) {
        const payload = msg.payload as { pairToken: string };
        setPairToken(payload.pairToken);
      }
      if (msg?.type === MsgTypes.PairSuccess) {
        const payload = msg.payload as { mobileUserId: string };
        setPairStatus(`Paired with mobile: ${payload.mobileUserId}`);
      }
      if (msg?.type?.startsWith("wb.")) {
        setIncoming(msg);
      }
      if (msg?.type === MsgTypes.WbHistory) {
        setHistory(
          msg.payload as {
            canUndo: boolean;
            canRedo: boolean;
            undoCount: number;
            redoCount: number;
          },
        );
      }
      if (msg?.type === MsgTypes.RtcPeers) {
        const list = ((msg as WsEnvelope<{ peers?: string[] }>).payload
          ?.peers ?? []) as string[];
        setPeers(list);
        handlePeers(list);
      }
      if (msg?.type === MsgTypes.RtcPeerJoined) {
        const pid =
          (msg as WsEnvelope<{ userId?: string }>).payload?.userId ?? "";
        setPeers((prev) => (prev.includes(pid) ? prev : [...prev, pid]));
        handlePeerJoined(pid);
      }
      if (msg?.type === MsgTypes.RtcPeerLeft) {
        const pid =
          (msg as WsEnvelope<{ userId?: string }>).payload?.userId ?? "";
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
        const joinedUserId =
          (msg as WsEnvelope<{ userId?: string }>).payload?.userId ?? undefined;
        setUserId(joinedUserId);
        setLastJoinedRoomId(roomId);
      }
      if (msg?.type === MsgTypes.ChatHistory) {
        const payload = msg.payload as { messages?: ChatMessagePayload[] };
        setChatMessages(payload?.messages ?? []);
      }
      if (msg?.type === MsgTypes.ChatMessage) {
        const payload = msg.payload as ChatMessagePayload;
        if (payload.clientId && pendingChatIdsRef.current.has(payload.clientId)) {
          pendingChatIdsRef.current.delete(payload.clientId);
          setChatMessages((prev) =>
            prev.map((m) => (m.clientId === payload.clientId ? payload : m))
          );
        } else {
          setChatMessages((prev) => [...prev, payload]);
        }
        setChatUnread((prev) => (chatOpenRef.current ? prev : prev + 1));
      }
    },
    [handlePeerJoined, handlePeerLeft, handlePeers, handleSignal, roomId],
  );

  useEffect(() => {
    handleMessageRef.current = handleMessage;
  }, [handleMessage]);

  const handleStatus = useCallback(
    (status: "connecting" | "open" | "closed") => {
      const isOpen = status === "open";
      setConnected(isOpen);
      if (isOpen && viewRef.current === "meeting") {
        const currentRoomId = roomIdRef.current;
        wsClientRef.current?.send({
          v: WS_VERSION,
          type: MsgTypes.JoinRoom,
          roomId: currentRoomId,
          payload: { roomId: currentRoomId }
        });
        setPairToken(null);
        setPairStatus("Not paired");
      }
    },
    []
  );

  useEffect(() => {
    if (wsClientRef.current) return;
    wsClientRef.current = new WsClient({
      url: `${REALTIME_URL}?role=web`,
      onStatus: handleStatus,
      onMessage: (msg) => handleMessageRef.current(msg)
    });
  }, [handleStatus]);

  const send = useCallback(
    <T,>(type: string, payload: T, roomId?: string, requestId?: string) => {
      const env: WsEnvelope<T> = {
        v: WS_VERSION,
        type,
        roomId,
        requestId,
        payload,
      };
      return wsClientRef.current?.send(env) ?? false;
    },
    [],
  );

  const {
    localStream,
    remoteStreams,
    micEnabled,
    camEnabled,
    startMedia,
    stopMedia,
    startScreenShare,
    stopScreenShare,
    toggleMic,
    toggleCam,
    closeAll,
  } = useWebRtc({ roomId, localUserId: userId, send });

  useEffect(() => {
    if (view !== "meeting") return;
    wsClientRef.current?.connect();
    return () => {
      wsClientRef.current?.close();
    };
  }, [view]);

  useEffect(() => {
    if (view !== "meeting") return;
    if (!autoStartMediaRef.current || autoStartDoneRef.current) return;
    autoStartDoneRef.current = true;
    startMedia({ audio: joinMic, video: joinCam }).catch((err: unknown) => {
      console.error("startMedia failed", err);
    });
  }, [view, joinMic, joinCam, startMedia]);

  useEffect(() => {
    if (!lastJoinedRoomId) return;
    if (lastJoinedRoomId !== roomId) return;
    send(MsgTypes.WbSnapshotRequest, {}, roomId);
    send(MsgTypes.ChatHistoryRequest, {}, roomId);
  }, [lastJoinedRoomId, roomId, send]);

  useEffect(() => {
    if (!pendingPairCreate) return;
    if (!lastJoinedRoomId) return;
    if (lastJoinedRoomId !== roomId) return;
    send(MsgTypes.PairCreate, {}, roomId);
  }, [lastJoinedRoomId, roomId, send, pendingPairCreate]);

  function createPairToken() {
    // Ensure we're in the room before requesting a pairing token.
    if (!connected) return;
    setPendingPairCreate(true);
    send(MsgTypes.JoinRoom, { roomId });
  }

  function sendChat() {
    const text = chatInput.trim();
    if (!text) return;
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingChatIdsRef.current.add(clientId);
    setChatMessages((prev) => [
      ...prev,
      {
        id: `local-${clientId}`,
        userId: userId ?? "me",
        name: participantName || undefined,
        text,
        ts: Date.now(),
        clientId
      }
    ]);
    send(MsgTypes.ChatMessage, { text, name: participantName, clientId }, roomId);
    setChatInput("");
  }

  // QR payload: keep it simple for now: just token text.
  // Mobile will scan token and then join the same roomId (entered or embedded later).
  // For v1 we embed roomId too:
  const qrValue = pairToken ? JSON.stringify({ roomId, pairToken }) : "";

  function openStartModal(action: "create" | "join") {
    setStartAction(action);
    setStartMicChoice(true);
    setStartCamChoice(true);
    setPendingName(participantName);
    setShowStartModal(true);
  }

  function confirmStart() {
    const nextRoomId = startAction === "create" ? nanoid(8) : homeRoomId.trim();
    if (!nextRoomId) return;
    roomIdRef.current = nextRoomId;
    setRoomId(nextRoomId);
    setJoinMic(startMicChoice);
    setJoinCam(startCamChoice);
    setParticipantName(pendingName.trim());
    setView("meeting");
    setShowStartModal(false);
    autoStartMediaRef.current = true;
    autoStartDoneRef.current = false;
  }

  if (view === "home") {
    return (
      <div className="home-shell">
        <div className="home-card">
          <div className="brand">
            <div className="brand-mark">inklo</div>
            <div className="brand-sub">Meet. Sketch. Collaborate.</div>
          </div>

          <div className="home-actions">
            <button
              className="primary-button"
              onClick={() => openStartModal("create")}
            >
              Create new meeting
            </button>

            <div className="home-join">
              <input
                value={homeRoomId}
                onChange={(e) => setHomeRoomId(e.target.value)}
                placeholder="Enter room ID"
              />
              <button
                className="ghost-button"
                onClick={() => openStartModal("join")}
                disabled={!homeRoomId.trim()}
              >
                Join room
              </button>
            </div>
          </div>
        </div>

        {showStartModal && (
          <div className="modal-backdrop">
            <div className="modal-card">
              <h3 style={{ marginTop: 0 }}>Start options</h3>
              <p className="small" style={{ marginTop: 4 }}>
                Choose how you want to enter the meeting.
              </p>

              <div className="modal-options">
                <label className="option-pill">
                  <span>Participant name</span>
                  <input
                    className="option-input"
                    value={pendingName}
                    onChange={(e) => setPendingName(e.target.value)}
                    placeholder="Your name"
                  />
                </label>
                <label className="option-pill">
                  <input
                    type="checkbox"
                    checked={startMicChoice}
                    onChange={(e) => setStartMicChoice(e.target.checked)}
                  />
                  Start with mic
                </label>
                <label className="option-pill">
                  <input
                    type="checkbox"
                    checked={startCamChoice}
                    onChange={(e) => setStartCamChoice(e.target.checked)}
                  />
                  Start with camera
                </label>
              </div>

              <div className="modal-actions">
                <button
                  className="ghost-button"
                  onClick={() => setShowStartModal(false)}
                >
                  Cancel
                </button>
                <button className="primary-button" onClick={confirmStart}>
                  Continue
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand">
          <div className="brand-mark">inlko</div>
          <div className="brand-sub">Web whiteboard + mobile companion</div>
        </div>

        <div className="island-menu">
          <div className="island-group">
            <div className="room-chip">Room {roomId}</div>
            <div className="small">Pair: {pairStatus}</div>
          </div>
        </div>

        <div className={`status-pill ${connected ? "on" : "off"}`}>
          <span className="status-dot" />
          {connected ? "Connected" : "Connecting"}
        </div>
      </header>

      <div className="main-grid">
        <aside className="side-column">
          <div className="card stage-card">
            <h3 style={{ marginTop: 0 }}>Participants</h3>

            <div className="participants-scroll">
              <VideoGrid
                localStream={localStream}
                remoteStreams={remoteStreams}
                localName={participantName || userId || "You"}
                localMuted={!micEnabled}
              />
            </div>
          </div>
        </aside>

        <main className="content-column">
          <div className="card whiteboard-card">
            <h3 style={{ marginTop: 0 }}>Whiteboard</h3>
            <WhiteboardCanvas
              roomId={roomId}
              send={send}
              incomingStroke={incoming}
              history={history}
            />
          </div>
        </main>
      </div>

      <div className="corner-actions">
        <div className="corner-row">
          <button
            className="island-button"
            onClick={() => {
              createPairToken();
              setShowPairing(true);
            }}
            disabled={!connected}
          >
            Generate pairing QR
          </button>

          <button
            className="island-button"
            onClick={() => {
              setChatOpen((prev) => !prev);
              setChatUnread(0);
            }}
            aria-label="Toggle chat"
          >
            Chat {chatUnread > 0 ? `(${chatUnread})` : ""}
          </button>

          <div className="participants-chip">
            <div className="participants-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 12a3 3 0 1 1 2.1-.88A3 3 0 0 1 7 12Zm10-1a2.5 2.5 0 1 1 1.8-.73A2.5 2.5 0 0 1 17 11Zm-10 2c2.8 0 5 1.3 5 3v2H2v-2c0-1.7 2.2-3 5-3Zm10 0c2.1 0 4 .9 4 2.2V18h-8v-2.8c0-.5-.2-1-.6-1.4a7 7 0 0 1 4.6-1.8Z" />
              </svg>
            </div>
            <span className="participants-badge">{1 + peers.length}</span>
          </div>
        </div>

        {showPairing && pairToken && (
          <div className="qr-pop">
            <div className="qr-pop-header">
              <div className="small">Scan this QR in the mobile app</div>
              <button
                className="qr-minimize"
                onClick={() => setShowPairing(false)}
                aria-label="Minimize QR"
              >
                -
              </button>
            </div>
            <div className="qr-wrap">
              <QRCodeCanvas value={qrValue} size={220} />
            </div>
            <div className="small" style={{ marginTop: 8 }}>
              Token expires quickly. If it fails, generate a new one.
            </div>
          </div>
        )}
      </div>

      {chatOpen && (
        <div className="chat-drawer">
          <div className="chat-header">
            <div>
              <div className="chat-title">Chat</div>
              <div className="small">Room {roomId}</div>
            </div>
            <button className="chat-close" onClick={() => setChatOpen(false)}>
              ✕
            </button>
          </div>
          <div className="chat-body">
            {chatMessages.length === 0 ? (
              <div className="small">No messages yet.</div>
            ) : (
              chatMessages.map((m) => (
                <div key={m.id} className="chat-row">
                  <div className="chat-name">
                    {m.name?.trim() || m.userId}
                  </div>
                  <div className="chat-text">{m.text}</div>
                  <div className="chat-time">
                    {Number.isFinite(m.ts)
                      ? new Date(m.ts).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit"
                        })
                      : "—"}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="chat-input">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Type a message…"
              onKeyDown={(e) => {
                if (e.key === "Enter") sendChat();
              }}
            />
            <button className="island-button" onClick={sendChat}>
              Send
            </button>
          </div>
        </div>
      )}

      <div className="control-dock">
        <button
          className={`control-btn ${micEnabled ? "" : "is-off"}`}
          onClick={toggleMic}
          disabled={!localStream}
          aria-label={micEnabled ? "Mute" : "Unmute"}
        >
          {micEnabled ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Zm7 9a1 1 0 0 1 2 0 9 9 0 0 1-7 8.77V22a1 1 0 0 1-2 0v-1.23A9 9 0 0 1 3 12a1 1 0 0 1 2 0 7 7 0 0 0 14 0Z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 4a3 3 0 0 1 6 0v3.2L9 12.2V4Zm10 8a1 1 0 0 1 2 0 9 9 0 0 1-4.1 7.5l-1.6-1.2A7 7 0 0 0 19 12ZM5 12a7 7 0 0 0 5 6.7V22a1 1 0 0 0 2 0v-1.2a9 9 0 0 0 2.6-.8l-1.5-1.5a7 7 0 0 1-7.1-6.3Zm-2.7-9a1 1 0 0 1 1.4 0l18 18a1 1 0 0 1-1.4 1.4l-2.7-2.7A5 5 0 0 1 9 17v-1.1l-5-5A1 1 0 0 1 4 9.5L2.3 7.8a1 1 0 0 1 0-1.4Z" />
            </svg>
          )}
        </button>

        <button
          className={`control-btn ${camEnabled ? "" : "is-off"}`}
          onClick={toggleCam}
          disabled={!localStream}
          aria-label={camEnabled ? "Camera off" : "Camera on"}
        >
          {camEnabled ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h9a2 2 0 0 1 2 2v2l4-2v8l-4-2v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h7l2 2h1a2 2 0 0 1 2 2v4l2 2v-8l-4 2V8a2 2 0 0 0-2-2H5.7L3.3 3.6A1 1 0 0 0 1.9 5l16.1 16.1a1 1 0 0 0 1.4-1.4L16 15.3V16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" />
            </svg>
          )}
        </button>

        <button
          className="control-btn hangup"
          onClick={() => {
            setSharing(false);
            stopMedia();
            closeAll();
          }}
          aria-label="Hang up"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 12c0-1.66 3.58-3 9-3s9 1.34 9 3c0 .79-.96 1.52-2.64 2.08l-1.75-2.62a1 1 0 0 0-1.7.03l-1.1 1.79c-.58.07-1.2.11-1.81.11-.62 0-1.23-.04-1.81-.11l-1.1-1.79a1 1 0 0 0-1.7-.03L5.64 14.1C3.96 13.52 3 12.79 3 12Z" />
          </svg>
        </button>

        <button
          className={`control-btn ${sharing ? "is-on" : ""}`}
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
          aria-label={sharing ? "Stop screen share" : "Share screen"}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H13l2 2v1H9v-1l2-2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v9h16V6H4Z" />
          </svg>
        </button>

        <button
          className={`control-btn ${handRaised ? "is-on" : ""}`}
          onClick={() => setHandRaised((prev) => !prev)}
          aria-label={handRaised ? "Lower hand" : "Raise hand"}
        >
          {handRaised ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 12a6 6 0 0 0 12 0V7a1 1 0 0 0-2 0v5h-1V6a1 1 0 1 0-2 0v6h-1V5a1 1 0 1 0-2 0v7H9V7a1 1 0 0 0-2 0v5Z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3a1 1 0 0 1 1 1v7h1V6a1 1 0 1 1 2 0v5h1V8a1 1 0 1 1 2 0v7.5a4.5 4.5 0 0 1-4.5 4.5H10a4 4 0 0 1-3.8-2.8l-2-6A1 1 0 1 1 6 10l1 2h1V5a1 1 0 0 1 2 0v7h1V4a1 1 0 0 1 1-1Z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

function VideoTile({
  stream,
  label,
  muted,
  displayName,
  showMutedIcon
}: {
  stream: MediaStream;
  label: string;
  muted?: boolean;
  displayName?: string;
  showMutedIcon?: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [hasVideo, setHasVideo] = useState(true);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.srcObject = stream;
  }, [stream, hasVideo]);

  useEffect(() => {
    const update = () => {
      const tracks = stream.getVideoTracks();
      setHasVideo(tracks.some((t) => t.enabled));
    };
    update();
    const interval = window.setInterval(update, 500);
    return () => clearInterval(interval);
  }, [stream]);

  const initials = (displayName ?? label ?? "U")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  return (
    <div className="participant-tile">
      <div className="small" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <div
        style={{
          position: "relative",
          width: "100%",
          borderRadius: 10,
          border: "1px solid #ddd",
          background: "#0f172a",
          overflow: "hidden",
          aspectRatio: "4 / 3"
        }}
      >
        {hasVideo ? (
          <video
            ref={ref}
            autoPlay
            playsInline
            muted={!!muted}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover"
            }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "grid",
              placeItems: "center",
              color: "#e2e8f0",
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: "0.04em",
              background:
                "radial-gradient(circle at 30% 20%, rgba(59,130,246,0.35), transparent 60%), #0f172a"
            }}
          >
            {initials || "U"}
          </div>
        )}

        {showMutedIcon && (
          <div
            style={{
              position: "absolute",
              bottom: 8,
              right: 8,
              width: 28,
              height: 28,
              borderRadius: 8,
              display: "grid",
              placeItems: "center",
              background: "rgba(15, 23, 42, 0.7)",
              border: "1px solid rgba(255,255,255,0.25)"
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: 16, height: 16, fill: "#e2e8f0" }}>
              <path d="M12 3a3 3 0 0 1 3 3v3.2l-2-2V6a1 1 0 1 0-2 0v1.2l-2-2V6a3 3 0 0 1 3-3Zm7 9a1 1 0 0 1 2 0 9 9 0 0 1-4.1 7.5l-1.6-1.2A7 7 0 0 0 19 12ZM5 12a7 7 0 0 0 5 6.7V22a1 1 0 0 0 2 0v-1.2a9 9 0 0 0 2.6-.8l-1.5-1.5a7 7 0 0 1-7.1-6.3Zm-2.7-9a1 1 0 0 1 1.4 0l18 18a1 1 0 0 1-1.4 1.4l-2.7-2.7A5 5 0 0 1 9 17v-1.1l-5-5A1 1 0 0 1 4 9.5L2.3 7.8a1 1 0 0 1 0-1.4Z" />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}

function VideoGrid({
  localStream,
  remoteStreams,
  localName,
  localMuted
}: {
  localStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>;
  localName?: string;
  localMuted?: boolean;
}) {
  const remoteEntries = Object.entries(remoteStreams);
  const totalCount = (localStream ? 1 : 0) + remoteEntries.length;

  return (
    <div className={`participants-grid ${totalCount > 1 ? "grid-3" : "grid-1"}`}>
      {localStream ? (
        <VideoTile
          stream={localStream}
          label="You"
          muted
          displayName={localName}
          showMutedIcon={!!localMuted}
        />
      ) : (
        <div className="small">No local media yet.</div>
      )}
      {remoteEntries.map(([userId, stream]) => (
        <VideoTile key={userId} stream={stream} label={`Peer ${userId}`} />
      ))}
    </div>
  );
}


