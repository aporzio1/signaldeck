// Smooth bursty rtl_tcp USB deliveries without changing their sample order.
// Bytes are interleaved unsigned 8-bit I/Q and must stay paired.
export class IqPacer {
  constructor(rate, emit, consumers) {
    this.rate = rate;
    this.emit = emit;
    this.consumers = consumers || null;
    this.queue = [];
    this.bytes = 0;
    this.offset = 0;
    this.started = false;
    this.last = 0;
    this.credit = 0;
    this.timer = setInterval(() => this.tick(), 10);
    this.timer.unref?.();
  }

  setRate(rate) {
    this.rate = rate;
    // Samples acquired under different rates must not share the reservoir.
    this.queue = [];
    this.bytes = this.offset = this.credit = 0;
    this.started = false;
  }

  push(buffer) {
    if (!buffer.length) return;
    this.queue.push(buffer);
    this.bytes += buffer.length;
    // Bound latency if the upstream clock runs faster than the consumer.
    const limit = Math.ceil(this.rate * 2) * 2; // two seconds
    while (this.bytes > limit && this.queue.length > 1) {
      this.bytes -= this.queue.shift().length - this.offset;
      this.offset = 0;
    }
  }

  tick() {
    const now = performance.now();
    // Nobody listening: hold the reservoir and the clock. Draining IQ into an
    // empty hub left the next client facing raw ~130 ms USB waves until the
    // buffer refilled, which is exactly the stutter this class removes.
    if (this.consumers && !this.consumers()) {
      this.started = false;
      this.last = now;
      this.credit = 0;
      return;
    }
    if (!this.started) {
      // Prime with a little over one USB wave (130 ms x 2 MB/s) plus the drain
      // of the longest expected gap, then never re-prime: re-priming after a
      // drain reintroduced ~130 ms gaps, which is the bug this class exists to
      // remove. Standing stock oscillates above zero while the radio streams.
      if (this.bytes < this.rate * 2 * 0.4) return;
      this.started = true;
      this.last = now;
      return;
    }
    const elapsed = Math.min(now - this.last, 50);
    this.last = now;
    this.credit += this.rate * 2 * elapsed / 1000;
    const count = Math.min(Math.floor(this.credit / 2) * 2, this.bytes);
    if (!count) return; // genuine underrun (retune/stop), not a re-prime
    this.credit -= count;
    const out = Buffer.allocUnsafe(count);
    let written = 0;
    while (written < count) {
      const head = this.queue[0];
      const take = Math.min(count - written, head.length - this.offset);
      head.copy(out, written, this.offset, this.offset + take);
      this.offset += take;
      written += take;
      if (this.offset === head.length) { this.queue.shift(); this.offset = 0; }
    }
    this.bytes -= count;
    this.emit(out);
  }

  stop() {
    clearInterval(this.timer);
    this.queue = [];
    this.bytes = this.offset = this.credit = 0;
    this.started = false;
  }
}
