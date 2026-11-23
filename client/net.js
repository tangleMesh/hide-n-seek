// WebSocket wrapper with automatic reconnect (exponential backoff) and session resume via token.
export class Net {
  constructor(getToken) {
    this.getToken = getToken;
    this.handlers = new Map();
    this.ws = null;
    this.backoff = 500;
    this.wanted = false;
    this.onStatus = () => {};
  }

  on(type, fn) {
    this.handlers.set(type, fn);
  }

  connect() {
    this.wanted = true;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      ws.send(JSON.stringify({ t: 'hello', token: this.getToken() }));
      this.onStatus(true);
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const h = this.handlers.get(msg.t);
      if (h) h(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.onStatus(false);
      if (!this.wanted) return;
      setTimeout(() => this.wanted && this.connect(), this.backoff);
      this.backoff = Math.min(8000, this.backoff * 1.8);
    };
  }

  disconnect() {
    this.wanted = false;
    this.ws?.close();
  }

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
}
