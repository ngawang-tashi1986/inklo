import { WS_VERSION, MsgTypes, type WsEnvelope } from "@inlko/shared";

export type WsHandlers = {
  onMessage: (msg: any) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

export function createWs(url: string, handlers: WsHandlers) {
  const ws = new WebSocket(url);

  ws.onopen = () => handlers.onOpen?.();
  ws.onclose = () => handlers.onClose?.();
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handlers.onMessage(msg);
    } catch {}
  };

  function send<T>(type: string, payload: T, roomId?: string, requestId?: string) {
    const env: WsEnvelope<T> = {
      v: WS_VERSION,
      type,
      roomId,
      requestId,
      payload
    };
    ws.send(JSON.stringify(env));
  }

  return { ws, send };
}
