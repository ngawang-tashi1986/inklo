import { logEvent } from "./logger";

type WsClientOpts = {
  url: string;
  onMessage: (msg: any) => void;
  onStatus?: (status: "connecting" | "open" | "closed") => void;
};

export class WsClient {
  private ws: WebSocket | null = null;
  private opts: WsClientOpts;
  private reconnectTimer: number | null = null;
  private shouldReconnect = true;
  private backoffMs = 250;

  constructor(opts: WsClientOpts) {
    this.opts = opts;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.opts.onStatus?.("connecting");
    logEvent("info", "ws connect", { url: this.opts.url });

    try {
      this.ws = new WebSocket(this.opts.url);
    } catch {
      logEvent("error", "ws new failed", { url: this.opts.url });
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.backoffMs = 250;
      this.opts.onStatus?.("open");
      logEvent("info", "ws open", { url: this.opts.url });
    };

    this.ws.onmessage = (ev) => {
      try {
        this.opts.onMessage(JSON.parse(ev.data));
      } catch {
        // ignore invalid messages
      }
    };

    this.ws.onerror = () => {
      // errors are followed by close in most browsers
      logEvent("error", "ws error", { url: this.opts.url });
    };

    this.ws.onclose = (ev) => {
      this.opts.onStatus?.("closed");
      // Helpful logging:
      console.warn("WS closed", { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      logEvent("warn", "ws closed", {
        url: this.opts.url,
        code: ev.code,
        reason: ev.reason,
        wasClean: ev.wasClean
      });

      this.ws = null;
      if (this.shouldReconnect) this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer != null) return;

    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 5000);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  send(msg: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // don't spam console; just drop if not connected
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close() {
    this.shouldReconnect = false;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.opts.onStatus?.("closed");
    logEvent("info", "ws close called", { url: this.opts.url });
  }
}
