import http from "http";
import { WebSocketServer } from "ws";
import { nanoid } from "nanoid";
import { EnvelopeSchema, MsgTypes, WS_VERSION } from "@inlko/shared";
const PORT = Number(process.env.PORT ?? 8080);
const server = http.createServer();
const wss = new WebSocketServer({ server });
const rooms = new Map();
const pairTokens = new Map();
function getOrCreateRoom(roomId) {
    let room = rooms.get(roomId);
    if (!room) {
        room = { roomId, clients: new Set() };
        rooms.set(roomId, room);
    }
    return room;
}
function safeSend(ws, msg) {
    if (ws.readyState === ws.OPEN)
        ws.send(JSON.stringify(msg));
}
function broadcast(roomId, msg, except) {
    const room = rooms.get(roomId);
    if (!room)
        return;
    for (const c of room.clients) {
        if (except && c.socket === except)
            continue;
        safeSend(c.socket, msg);
    }
}
function cleanupExpiredTokens() {
    const now = Date.now();
    for (const [token, info] of pairTokens.entries()) {
        if (info.expiresAt <= now)
            pairTokens.delete(token);
    }
}
setInterval(cleanupExpiredTokens, 10_000);
wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const roleParam = url.searchParams.get("role");
    const role = roleParam === "mobile" ? "mobile" : "web";
    const client = {
        socket,
        userId: nanoid(10),
        role
    };
    socket.on("message", (raw) => {
        let parsed;
        try {
            parsed = JSON.parse(raw.toString());
        }
        catch {
            return;
        }
        const envRes = EnvelopeSchema.safeParse(parsed);
        if (!envRes.success)
            return;
        const env = envRes.data;
        const { type, payload, requestId } = env;
        // room.join
        if (type === MsgTypes.JoinRoom) {
            const roomId = String(payload?.roomId ?? "");
            if (!roomId)
                return;
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
            return;
        }
        // Must be in a room after this point
        const roomId = client.roomId;
        if (!roomId)
            return;
        // pair.create (web only)
        if (type === MsgTypes.PairCreate) {
            if (client.role !== "web")
                return;
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
            if (client.role !== "mobile")
                return;
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
        if (type === MsgTypes.WbStrokeStart ||
            type === MsgTypes.WbStrokeMove ||
            type === MsgTypes.WbStrokeEnd ||
            type === MsgTypes.WbClear) {
            // attach sender identity (server authoritative)
            const outgoing = {
                v: WS_VERSION,
                type,
                roomId,
                userId: client.userId,
                payload
            };
            // broadcast to everyone including sender (web can choose to ignore)
            broadcast(roomId, outgoing);
            return;
        }
    });
    socket.on("close", () => {
        if (client.roomId) {
            const room = rooms.get(client.roomId);
            room?.clients.delete(client);
            if (room && room.clients.size === 0)
                rooms.delete(room.roomId);
        }
    });
    // small hello (optional)
    safeSend(socket, { v: WS_VERSION, type: "hello", payload: { userId: client.userId, role } });
});
server.listen(PORT, () => {
    console.log(`[inlko realtime] ws://localhost:${PORT}`);
});
