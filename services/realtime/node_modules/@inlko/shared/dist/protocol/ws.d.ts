import { z } from "zod";
export declare const WS_VERSION: 1;
export declare const EnvelopeSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    type: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
    roomId: z.ZodOptional<z.ZodString>;
    userId: z.ZodOptional<z.ZodString>;
    payload: z.ZodUnknown;
}, z.core.$strip>;
export type WsEnvelope<TPayload> = {
    v: typeof WS_VERSION;
    type: string;
    requestId?: string;
    roomId?: string;
    userId?: string;
    payload: TPayload;
};
export type Point = {
    x: number;
    y: number;
    t: number;
};
export type StrokeStyle = {
    tool: "pen" | "highlighter" | "eraser";
    color: string;
    width: number;
    opacity: number;
};
export type StrokeMsg = {
    strokeId: string;
    style: StrokeStyle;
    points: Point[];
};
export type PairCreated = {
    pairToken: string;
    expiresAt: number;
};
export type PairClaim = {
    pairToken: string;
};
export declare const MsgTypes: {
    readonly JoinRoom: "room.join";
    readonly JoinedRoom: "room.joined";
    readonly PairCreate: "pair.create";
    readonly PairCreated: "pair.created";
    readonly PairClaim: "pair.claim";
    readonly PairSuccess: "pair.success";
    readonly WbStrokeStart: "wb.stroke.start";
    readonly WbStrokeMove: "wb.stroke.move";
    readonly WbStrokeEnd: "wb.stroke.end";
    readonly WbClear: "wb.clear";
};
