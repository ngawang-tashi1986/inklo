import { z } from "zod";
export const WS_VERSION = 1;
export const EnvelopeSchema = z.object({
    v: z.literal(WS_VERSION),
    type: z.string(),
    requestId: z.string().optional(),
    roomId: z.string().optional(),
    userId: z.string().optional(),
    payload: z.unknown()
});
export const MsgTypes = {
    JoinRoom: "room.join",
    JoinedRoom: "room.joined",
    PairCreate: "pair.create",
    PairCreated: "pair.created",
    PairClaim: "pair.claim",
    PairSuccess: "pair.success",
    WbSnapshotRequest: "wb.snapshot.request",
    WbSnapshot: "wb.snapshot",
    WbStrokeStart: "wb.stroke.start",
    WbStrokeMove: "wb.stroke.move",
    WbStrokeEnd: "wb.stroke.end",
    WbClear: "wb.clear",
    WbStrokeRemove: "wb.stroke.remove",
    WbStrokeRestore: "wb.stroke.restore",
    WbUndo: "wb.undo",
    WbRedo: "wb.redo",
    WbHistory: "wb.history",
    // WebRTC signaling
    RtcPeers: "rtc.peers",
    RtcPeerJoined: "rtc.peer.joined",
    RtcPeerLeft: "rtc.peer.left",
    RtcOffer: "rtc.offer",
    RtcAnswer: "rtc.answer",
    RtcIce: "rtc.ice",
    CursorMove: "cursor.move"
};
