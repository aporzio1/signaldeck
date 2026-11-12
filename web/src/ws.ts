type JsonHandler = (data: any) => void;
type BinaryHandler = (buffer: ArrayBuffer) => void;

class Live {
  private socket: WebSocket | null = null;
  private wanted = new Set<string>();
  private jsonHandlers = new Map<string, Set<JsonHandler>>();
  private binaryHandlers = new Set<BinaryHandler>();
  private retry = 0;
  private timer: any = null;
  private open = false;
  private queue: string[] = [];

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.open = true;
      this.retry = 0;
      this.sendSubscribe();
      for (const payload of this.queue.splice(0)) socket.send(payload);
    };
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        let message: any;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'hello' || message.type === 'pong' || message.type === 'subscribed') return;
        const handlers = this.jsonHandlers.get(message.type);
        if (handlers) for (const handler of handlers) handler(message.data);
        return;
      }
      for (const handler of this.binaryHandlers) handler(event.data as ArrayBuffer);
    };
    socket.onclose = () => {
      this.open = false;
      if (!this.jsonHandlers.size && !this.binaryHandlers.size) return;
      const delay = Math.min(15000, 600 * 2 ** this.retry++);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.connect(), delay);
    };
    socket.onerror = () => socket.close();
  }

  private sendSubscribe() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ op: 'subscribe', channels: [...this.wanted] }));
  }

  private ensure(channels: string[]) {
    let changed = false;
    for (const channel of channels) {
      if (!this.wanted.has(channel)) {
        this.wanted.add(channel);
        changed = true;
      }
    }
    if (changed) {
      this.connect();
      this.sendSubscribe();
    } else {
      this.connect();
    }
  }

  subscribe(channels: string[], handler: JsonHandler): () => void {
    for (const channel of channels) {
      if (!this.jsonHandlers.has(channel)) this.jsonHandlers.set(channel, new Set());
      this.jsonHandlers.get(channel)!.add(handler);
    }
    this.ensure(channels);
    return () => {
      for (const channel of channels) {
        const set = this.jsonHandlers.get(channel);
        set?.delete(handler);
      }
    };
  }

  subscribeBinary(handler: BinaryHandler): () => void {
    this.binaryHandlers.add(handler);
    this.ensure(['sdr-iq']);
    return () => this.binaryHandlers.delete(handler);
  }

  get connected() {
    return this.open;
  }
}

export const live = new Live();
