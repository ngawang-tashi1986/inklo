import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { nanoid } from "nanoid";
import { EnvelopeSchema, MsgTypes, WS_VERSION, type WsEnvelope, type StrokeMsg, type WbHistoryMsg } from "@inlko/shared";

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
};

type PairTokenInfo = {
  token: string;
  roomId: string;
  webUserId: string;
  expiresAt: number;
};

const PORT = Number(process.env.PORT ?? 8080);
const server = http.createServer();
const wss = new WebSocketServer({ server });

// --- persistence (single-board) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    redo: new Map()
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

function broadcast(roomId: string, msg: unknown, except?: WebSocket) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const c of room.clients) {
    if (except && c.socket === except) continue;
    safeSend(c.socket, msg);
  }
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

  const client: ClientMeta = {
    socket,
    userId: nanoid(10),
    role
  };

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

    // room.join
    if (type === MsgTypes.JoinRoom) {
      const roomId = String(payload?.roomId ?? "");
      if (!roomId) return;

      // move client between rooms if needed
      if (client.roomId) {
        const oldRoom = rooms.get(client.roomId);
        oldRoom?.clients.delete(client);
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

      return;
    }

    // Must be in a room after this point
    const roomId = client.roomId;
    if (!roomId) return;

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
  });

  socket.on("close", () => {
    if (client.roomId) {
      const room = rooms.get(client.roomId);
      room?.clients.delete(client);
      if (room && room.clients.size === 0) rooms.delete(room.roomId);
    }
  });

  // small hello (optional)
  safeSend(socket, { v: WS_VERSION, type: "hello", payload: { userId: client.userId, role } });
});

server.listen(PORT, () => {
  console.log(`[inlko realtime] ws://localhost:${PORT}`);
});
