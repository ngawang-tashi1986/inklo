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
    WbStrokeStart: "wb.stroke.start",
    WbStrokeMove: "wb.stroke.move",
    WbStrokeEnd: "wb.stroke.end",
    WbClear: "wb.clear"
};
