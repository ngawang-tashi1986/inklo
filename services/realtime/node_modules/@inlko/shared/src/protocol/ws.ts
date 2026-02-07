import { z } from "zod";

export const WS_VERSION = 1 as const;

export const EnvelopeSchema = z.object({
  v: z.literal(WS_VERSION),
  type: z.string(),
  requestId: z.string().optional(),
  roomId: z.string().optional(),
  userId: z.string().optional(),
  payload: z.unknown()
});

export type WsEnvelope<TPayload> = {
  v: typeof WS_VERSION;
  type: string;
  requestId?: string;
  roomId?: string;
  userId?: string;
  payload: TPayload;
};

export type Point = { x: number; y: number; t: number };

export type StrokeStyle = {
  tool: "pen" | "highlighter" | "eraser";
  color: string;   // hex
  width: number;   // relative
  opacity: number; // 0..1
};

export type StrokeMsg = {
  strokeId: string;
  style: StrokeStyle;
  points: Point[];
};

export type CursorMsg = {
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  isDrawing?: boolean;
};

export type StrokeRemoveMsg = { strokeId: string };
export type StrokeRestoreMsg = { stroke: StrokeMsg & { userId?: string } };
export type WbHistoryMsg = {
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
};
export type RtcPeersMsg = {
  peers: string[]; // userIds in the room (excluding you)
};
export type RtcPeerJoinedMsg = {
  userId: string;
};
export type RtcPeerLeftMsg = {
  userId: string;
};
export type RtcOfferMsg = {
  toUserId: string;
  sdp: RTCSessionDescriptionInit;
};
export type RtcAnswerMsg = {
  toUserId: string;
  sdp: RTCSessionDescriptionInit;
};
export type RtcIceMsg = {
  toUserId: string;
  candidate: RTCIceCandidateInit;
};

export type PairCreated = { pairToken: string; expiresAt: number };
export type PairClaim = { pairToken: string };
export type ChatMessagePayload = {
  id: string;
  userId: string;
  name?: string;
  text: string;
  ts: number;
  clientId?: string;
};
export type ChatSendPayload = {
  text: string;
  name?: string;
  clientId?: string;
};
export type ChatHistoryPayload = {
  messages: ChatMessagePayload[];
};

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

  CursorMove: "cursor.move",

  ChatMessage: "chat.message",
  ChatHistory: "chat.history",
  ChatHistoryRequest: "chat.history.request"
} as const;
