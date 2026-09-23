// WebSocket client for the live event hub (transcript / speech / status).
// Reconnects with backoff and keeps the connection alive with pings.

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const PING_MS = 25_000;

export class EventsClient {
  constructor({ url, onMessage, onState }) {
    this.url = url;
    this.onMessage = onMessage;
    this.onState = onState;
    this.ws = null;
    this.attempt = 0;
    this.stopped = true;
    this.retryTimer = null;
    this.pingTimer = null;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    this.onState(this.attempt ? "reconnecting" : "connecting");
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.onState("connected");
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, PING_MS);
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws || typeof event.data !== "string" || event.data === "pong") return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      this.retry();
    };
  }

  retry() {
    if (this.stopped) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.onState("reconnecting");
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {
        // ignore
      }
    }
    this.ws = null;
    this.onState("offline");
  }
}
