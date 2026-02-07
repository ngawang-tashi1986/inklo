import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { nanoid } from "nanoid";
import { EnvelopeSchema, MsgTypes, WS_VERSION, type WsEnvelope, type StrokeMsg, type WbHistoryMsg, type ChatMessagePayload, type ChatSendPayload, type ChatHistoryPayload } from "@inlko/shared";

type ClientMeta = {
  socket: WebSocket;
  userId: string;
  roomId?: string;
  role: "web" | "mobile";
  pairedToUserId?: string; // for mobile companions
};

type StoredStroke = StrokeMsg & { userId: string };

type Room = {
  roomId: string;
  clients: Set<ClientMeta>;
  strokes: Map<string, StoredStroke>;
  undo: Map<string, string[]>;
  redo: Map<string, StoredStroke[]>;
  chat: ChatMessagePayload[];
};

type PairTokenInfo = {
  token: string;
  roomId: string;
  webUserId: string;
  expiresAt: number;
};

const PORT = Number(process.env.PORT ?? 8080);

// --- logging ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.resolve(__dirname, "..", "..", "..", "logs");
const DEBUG_LOGS = process.env.REALTIME_DEBUG_LOGS === "true";
if (DEBUG_LOGS) fs.mkdirSync(LOG_DIR, { recursive: true });

function appendLog(app: string, level: "info" | "warn" | "error", msg: string, data?: unknown) {
  if (!DEBUG_LOGS) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    app,
    level,
    msg,
    data
  }) + "\n";

  try {
    fs.appendFileSync(path.join(LOG_DIR, `${app}.log`), line, "utf-8");
  } catch {}

  if (level === "error") console.error(`[${app}] ${msg}`, data ?? "");
  else if (level === "warn") console.warn(`[${app}] ${msg}`, data ?? "");
  else console.log(`[${app}] ${msg}`, data ?? "");
}

function toJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/log") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(raw || "{}");
        const app = String(payload?.app ?? "unknown");
        const level = (payload?.level === "warn" || payload?.level === "error") ? payload.level : "info";
        const msg = String(payload?.msg ?? "log");
        const data = payload?.data ?? null;
        appendLog(app, level, msg, data);
        toJson(res, 200, { ok: true });
      } catch {
        toJson(res, 400, { ok: false });
      }
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/plain",
    "Access-Control-Allow-Origin": "*"
  });
  res.end("ok");
});
const wss = new WebSocketServer({ server });

// --- persistence (single-board) ---

// This will resolve to: services/realtime/data/rooms
const DATA_DIR = path.resolve(__dirname, "..", "data", "rooms");
fs.mkdirSync(DATA_DIR, { recursive: true });

function roomFile(roomId: string) {
  return path.join(DATA_DIR, `${roomId}.json`);
}

// Debounced save per room
const saveTimers = new Map<string, NodeJS.Timeout>();

function scheduleSave(room: Room) {
  const key = room.roomId;
  const existing = saveTimers.get(key);
  if (existing) clearTimeout(existing);

  const t = setTimeout(() => {
    saveTimers.delete(key);
    saveRoom(room);
  }, 250);

  saveTimers.set(key, t);
}

function saveRoom(room: Room) {
  const file = roomFile(room.roomId);

  const data = {
    roomId: room.roomId,
    savedAt: Date.now(),
    strokes: Array.from(room.strokes.values())
  };

  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

function loadRoomStrokes(roomId: string): StoredStroke[] {
  const file = roomFile(roomId);
  if (!fs.existsSync(file)) return [];

  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    const strokes = Array.isArray(parsed?.strokes) ? parsed.strokes : [];
    return strokes as StoredStroke[];
  } catch {
    return [];
  }
}

const rooms = new Map<string, Room>();
const pairTokens = new Map<string, PairTokenInfo>();

function getOrCreateRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (room) return room;

  const strokesFromDisk = loadRoomStrokes(roomId);
  const strokes = new Map<string, StoredStroke>();
  for (const s of strokesFromDisk) {
    if (s?.strokeId) strokes.set(s.strokeId, s);
  }

  room = {
    roomId,
    clients: new Set(),
    strokes,
    undo: new Map(),
    redo: new Map(),
    chat: []
  };

  rooms.set(roomId, room);
  return room;
}

function getUndoStack(room: Room, userId: string) {
  let s = room.undo.get(userId);
  if (!s) {
    s = [];
    room.undo.set(userId, s);
  }
  return s;
}

function getRedoStack(room: Room, userId: string) {
  let s = room.redo.get(userId);
  if (!s) {
    s = [];
    room.redo.set(userId, s);
  }
  return s;
}

function safeSend(ws: WebSocket, msg: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sendHistory(room: Room, client: ClientMeta) {
  const undoStack = getUndoStack(room, client.userId);
  const redoStack = getRedoStack(room, client.userId);

  const payload: WbHistoryMsg = {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoCount: undoStack.length,
    redoCount: redoStack.length
  };

  safeSend(client.socket, {
    v: WS_VERSION,
    type: MsgTypes.WbHistory,
    roomId: room.roomId,
    userId: client.userId,
    payload
  });
}

function sendChatHistory(room: Room, client: ClientMeta) {
  const payload: ChatHistoryPayload = {
    messages: room.chat.slice(-100)
  };
  safeSend(client.socket, {
    v: WS_VERSION,
    type: MsgTypes.ChatHistory,
    roomId: room.roomId,
    userId: client.userId,
    payload
  });
}

function broadcast(roomId: string, msg: unknown, except?: WebSocket) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const c of room.clients) {
    if (except && c.socket === except) continue;
    safeSend(c.socket, msg);
  }
}

function listPeerUserIds(room: Room, excludeUserId: string) {
  const ids: string[] = [];
  for (const c of room.clients) {
    if (c.userId !== excludeUserId) ids.push(c.userId);
  }
  return ids;
}

function findClientByUserId(room: Room, userId: string) {
  for (const c of room.clients) {
    if (c.userId === userId) return c;
  }
  return null;
}

function cleanupExpiredTokens() {
  const now = Date.now();
  for (const [token, info] of pairTokens.entries()) {
    if (info.expiresAt <= now) pairTokens.delete(token);
  }
}
setInterval(cleanupExpiredTokens, 10_000);

wss.on("connection", (socket, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const roleParam = url.searchParams.get("role");
  const role: ClientMeta["role"] = roleParam === "mobile" ? "mobile" : "web";
  const remote = `${req.socket.remoteAddress ?? "unknown"}:${req.socket.remotePort ?? "?"}`;

  const client: ClientMeta = {
    socket,
    userId: nanoid(10),
    role
  };

  appendLog("realtime", "info", "ws connected", {
    userId: client.userId,
    role,
    remote,
    path: url.pathname,
    query: url.search
  });

  socket.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const envRes = EnvelopeSchema.safeParse(parsed);
    if (!envRes.success) return;

    const env = envRes.data as WsEnvelope<any>;
    const { type, payload, requestId } = env;
    appendLog("realtime", "info", "message", {
      type,
      roomId: env.roomId ?? null,
      userId: env.userId ?? null
    });

    // room.join
    if (type === MsgTypes.JoinRoom) {
      const roomId = String(payload?.roomId ?? "");
      if (!roomId) return;

      appendLog("realtime", "info", "join room", {
        userId: client.userId,
        role: client.role,
        roomId
      });

      // move client between rooms if needed
      if (client.roomId) {
        const oldRoom = rooms.get(client.roomId);
        if (oldRoom) {
          oldRoom.clients.delete(client);

          // notify old room that this peer left
          broadcast(oldRoom.roomId, {
            v: WS_VERSION,
            type: MsgTypes.RtcPeerLeft,
            roomId: oldRoom.roomId,
            payload: { userId: client.userId }
          });

          if (oldRoom.clients.size === 0) rooms.delete(oldRoom.roomId);
        }
      }

      client.roomId = roomId;
      const room = getOrCreateRoom(roomId);
      room.clients.add(client);

      safeSend(socket, {
        v: WS_VERSION,
        type: MsgTypes.JoinedRoom,
        requestId,
        roomId,
        userId: client.userId,
        payload: { ok: true }
      });

      // 1) Send current peers to the newly joined client
      safeSend(socket, {
        v: WS_VERSION,
        type: MsgTypes.RtcPeers,
        roomId,
        payload: { peers: listPeerUserIds(room, client.userId) }
      });

      // 2) Notify existing peers that a new peer joined
      broadcast(
        roomId,
        {
          v: WS_VERSION,
          type: MsgTypes.RtcPeerJoined,
          roomId,
          payload: { userId: client.userId }
        },
        socket
      );

      // Send snapshot to the newly joined client
      const snapshot = {
        v: WS_VERSION,
        type: MsgTypes.WbSnapshot,
        roomId,
        payload: {
          strokes: Array.from(room.strokes.values())
        }
      };
      safeSend(socket, snapshot);
      sendHistory(room, client);
      sendChatHistory(room, client);

      return;
    }

    // Must be in a room after this point
    const roomId = client.roomId;
    if (!roomId) return;

    // WebRTC signaling relay (offer/answer/ice)
    if (type === MsgTypes.RtcOffer || type === MsgTypes.RtcAnswer || type === MsgTypes.RtcIce) {
      const room = rooms.get(roomId);
      if (!room) return;

      const toUserId = String(payload?.toUserId ?? "");
      if (!toUserId) return;

      const target = findClientByUserId(room, toUserId);
      if (!target) return;

      // Relay to the target. Sender identity is in envelope.userId.
      safeSend(target.socket, {
        v: WS_VERSION,
        type,
        roomId,
        userId: client.userId,
        payload
      });

      return;
    }

    if (type === MsgTypes.WbUndo) {
      const room = rooms.get(roomId);
      if (!room) return;

      const undoStack = getUndoStack(room, client.userId);
      const redoStack = getRedoStack(room, client.userId);

      // pop until we find a stroke that still exists and belongs to user
      while (undoStack.length > 0) {
        const strokeId = undoStack.pop()!;
        const stroke = room.strokes.get(strokeId);
        if (!stroke) continue;
        if (stroke.userId !== client.userId) continue;

        room.strokes.delete(strokeId);
        redoStack.push(stroke);

        broadcast(roomId, {
          v: WS_VERSION,
          type: MsgTypes.WbStrokeRemove,
          roomId,
          userId: client.userId,
          payload: { strokeId }
        });

        sendHistory(room, client);
        scheduleSave(room);

        return;
      }
      return;
    }

    if (type === MsgTypes.WbRedo) {
      const room = rooms.get(roomId);
      if (!room) return;

      const undoStack = getUndoStack(room, client.userId);
      const redoStack = getRedoStack(room, client.userId);

      const stroke = redoStack.pop();
      if (!stroke) return;

      room.strokes.set(stroke.strokeId, stroke);
      undoStack.push(stroke.strokeId);

      broadcast(roomId, {
        v: WS_VERSION,
        type: MsgTypes.WbStrokeRestore,
        roomId,
        userId: client.userId,
        payload: { stroke }
      });

      sendHistory(room, client);
      scheduleSave(room);

      return;
    }

    if (type === MsgTypes.WbSnapshotRequest) {
      const room = rooms.get(roomId);
      if (!room) return;

      safeSend(socket, {
        v: WS_VERSION,
        type: MsgTypes.WbSnapshot,
        roomId,
        payload: { strokes: Array.from(room.strokes.values()) }
      });
      return;
    }

    if (type === MsgTypes.CursorMove) {
      const outgoing = {
        v: WS_VERSION,
        type,
        roomId,
        userId: client.userId,
        payload
      };
      // broadcast to everyone EXCEPT sender (optional)
      broadcast(roomId, outgoing, socket);
      return;
    }

    // pair.create (web only)
    if (type === MsgTypes.PairCreate) {
      if (client.role !== "web") return;

      const token = nanoid(16);
      const expiresAt = Date.now() + 2 * 60 * 1000; // 2 minutes

      pairTokens.set(token, {
        token,
        roomId,
        webUserId: client.userId,
        expiresAt
      });

      safeSend(socket, {
        v: WS_VERSION,
        type: MsgTypes.PairCreated,
        requestId,
        roomId,
        userId: client.userId,
        payload: { pairToken: token, expiresAt }
      });

      return;
    }

    // pair.claim (mobile)
    if (type === MsgTypes.PairClaim) {
      if (client.role !== "mobile") return;

      const pairToken = String(payload?.pairToken ?? "");
      const info = pairTokens.get(pairToken);
      if (!info) {
        safeSend(socket, {
          v: WS_VERSION,
          type: "pair.error",
          requestId,
          roomId,
          userId: client.userId,
          payload: { message: "Invalid or expired token" }
        });
        return;
      }

      if (info.roomId !== roomId) {
        safeSend(socket, {
          v: WS_VERSION,
          type: "pair.error",
          requestId,
          roomId,
          userId: client.userId,
          payload: { message: "Token is for a different room" }
        });
        return;
      }

      client.pairedToUserId = info.webUserId;
      pairTokens.delete(pairToken);

      const successMsg = {
        v: WS_VERSION,
        type: MsgTypes.PairSuccess,
        roomId,
        payload: {
          mobileUserId: client.userId,
          webUserId: info.webUserId
        }
      };

      // notify the mobile
      safeSend(socket, successMsg);

      // notify the paired web user only
      const room = rooms.get(roomId);
      if (room) {
        for (const c of room.clients) {
          if (c.role === "web" && c.userId === info.webUserId) {
            safeSend(c.socket, successMsg);
          }
        }
      }

      return;
    }

    // Whiteboard events: broadcast to room
    if (
      type === MsgTypes.WbStrokeStart ||
      type === MsgTypes.WbStrokeMove ||
      type === MsgTypes.WbStrokeEnd ||
      type === MsgTypes.WbClear
    ) {
      const room = rooms.get(roomId);
      if (!room) return;

      if (type === MsgTypes.WbClear) {
        room.strokes.clear();
        room.undo.clear();
        room.redo.clear();
        const outgoing = { v: WS_VERSION, type, roomId, userId: client.userId, payload: {} };
        broadcast(roomId, outgoing);
        sendHistory(room, client);
        scheduleSave(room);
        return;
      }

      const msg = payload as StrokeMsg;
      const existing = room.strokes.get(msg.strokeId);

      if (!existing) {
        if (type === MsgTypes.WbStrokeStart) {
          const undoStack = getUndoStack(room, client.userId);
          undoStack.push(msg.strokeId);

          const redoStack = getRedoStack(room, client.userId);
          redoStack.length = 0;

          sendHistory(room, client);
        }
        // create stroke
        room.strokes.set(msg.strokeId, {
          ...msg,
          userId: client.userId,
          points: [...msg.points]
        });
      } else {
        // append points
        existing.points.push(...msg.points);
        // style might come again; keep latest
        existing.style = msg.style;
      }

      const outgoing = {
        v: WS_VERSION,
        type,
        roomId,
        userId: client.userId,
        payload
      };

      // broadcast to everyone including sender (web can choose to ignore)
      scheduleSave(room);
      broadcast(roomId, outgoing);
      return;
    }

    if (type === MsgTypes.ChatHistoryRequest) {
      const room = rooms.get(roomId);
      if (!room) return;
      sendChatHistory(room, client);
      return;
    }

    if (type === MsgTypes.ChatMessage) {
      const room = rooms.get(roomId);
      if (!room) return;

      const incoming = payload as ChatSendPayload;
      const text = String(incoming?.text ?? "").trim();
      if (!text) return;

      const msg: ChatMessagePayload = {
        id: nanoid(12),
        userId: client.userId,
        name: typeof incoming?.name === "string" ? incoming.name : undefined,
        text,
        ts: Date.now(),
        clientId: typeof incoming?.clientId === "string" ? incoming.clientId : undefined
      };

      room.chat.push(msg);
      if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);

      broadcast(roomId, {
        v: WS_VERSION,
        type: MsgTypes.ChatMessage,
        roomId,
        userId: client.userId,
        payload: msg
      });

      return;
    }
  });

  socket.on("close", (code, reason) => {
    if (client.roomId) {
      const room = rooms.get(client.roomId);
      if (room) {
        room.clients.delete(client);

        broadcast(room.roomId, {
          v: WS_VERSION,
          type: MsgTypes.RtcPeerLeft,
          roomId: room.roomId,
          payload: { userId: client.userId }
        });

        if (room.clients.size === 0) rooms.delete(room.roomId);
      }
    }

    appendLog("realtime", "warn", "ws closed", {
      userId: client.userId,
      roomId: client.roomId ?? null,
      role: client.role,
      remote,
      code,
      reason: reason?.toString?.() ?? ""
    });
  });

  socket.on("error", (err) => {
    appendLog("realtime", "error", "ws error", {
      userId: client.userId,
      roomId: client.roomId ?? null,
      role: client.role,
      remote,
      message: err?.message
    });
  });

  // small hello (optional)
  safeSend(socket, { v: WS_VERSION, type: "hello", payload: { userId: client.userId, role } });
});

server.listen(PORT, "0.0.0.0", () => {
  appendLog("realtime", "info", "listening", { url: `ws://localhost:${PORT}` });
});
