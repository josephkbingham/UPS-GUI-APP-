import {
  capabilityPage,
  decode,
  frame,
  FrameDecoder,
  parseCommand,
  pollKeys,
  readingSummary,
} from "./protocol.js";

const realClock = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id),
};
const timedOut = () => Error("Response timed out");

export function refreshSeconds(value) {
  if (
    !String(value).trim() ||
    Number(value) < 1 ||
    !Number.isSafeInteger(Number(value)) ||
    !Number.isSafeInteger(Number(value) * 1000)
  )
    throw Error("Enter a whole number of seconds, at least 1.");
  return Number(value);
}

// Owns the single outstanding exchange. Framed replies have no correlation ID.
export class UpsSession {
  constructor(link, { profile = "model", seconds = 2, clock = realClock, emit = () => {} } = {}) {
    this.link = link;
    this.profile = profile;
    this.seconds = refreshSeconds(seconds);
    this.clock = clock;
    this.emit = emit;
    this.decoder = new FrameDecoder();
    this.mode = "frame";
    this.state = "closed";
    this.queue = [];
    this.cycle = [];
  }

  status(state, detail = "") {
    this.state = state;
    this.emit("status", { state, detail });
  }

  log(direction, wire, detail, origin = this.origin || "system") {
    this.emit("log", { direction, wire, detail, origin, time: this.clock.now() });
  }

  start({ recoverRouter = false } = {}) {
    this.link.start(
      (bytes) => this.receive(bytes),
      (error) => this.lost(error),
    );
    this.needSync = true;
    this.recovering = recoverRouter && this.profile === "dual";
    this.status("checking", this.recovering ? "Restoring router monitoring" : "Verifying serial link");
    this.cycle = [...pollKeys(this.profile), "MOD", "VER"];
    this.setInterval(this.seconds);
    this.pump();
  }

  setInterval(seconds) {
    this.seconds = refreshSeconds(seconds);
    this.clock.clear(this.timer);
    if (this.state === "closed" || this.stopping) return;
    this.nextTick = this.clock.now() + this.seconds * 1000;
    this.armTick();
  }

  armTick() {
    // Browsers limit individual timer delays to a signed 32-bit value.
    this.timer = this.clock.set(
      () => {
        if (this.stopping || this.state === "closed") return;
        if (this.clock.now() >= this.nextTick) {
          this.nextTick = this.clock.now() + this.seconds * 1000;
          if (!this.running && this.mode === "frame" && this.state !== "recovery") {
            this.cycle = pollKeys(this.profile);
            this.pump();
          }
        }
        this.armTick();
      },
      Math.min(Math.max(0, this.nextTick - this.clock.now()), 2147483647),
    );
  }

  submit(input, mode = "frame", target = "1") {
    if (this.state !== "live" || this.stopping)
      return Promise.reject(Error("Wait for a verified connection."));
    const cmd = parseCommand(input, this.profile, mode);
    if (!["1", "2"].includes(target)) throw Error("Select a valid board.");
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, target, resolve, reject });
      this.pump();
    });
  }

  pump() {
    if (this.running || this.stopping) return;
    this.running = this.run().finally(() => {
      this.running = null;
      if (!this.stopping && this.state === "live" && (this.queue.length || this.cycle.length)) this.pump();
    });
  }

  async run() {
    if (this.needSync) {
      try {
        this.origin = "system";
        if (this.recovering) await this.restoreRouter();
        else await this.synchronize();
        this.status("live");
      } catch (error) {
        if (!this.stopping) this.status(this.recovering ? "recovery" : "checking", error.message);
        this.cycle = [];
        return;
      }
    }
    while (!this.stopping && (this.queue.length || this.cycle.length)) {
      const job = this.queue.shift();
      const cmd = job?.cmd || parseCommand(this.cycle.shift(), this.profile, "frame");
      this.origin = job ? "manual" : "poll";
      try {
        if (cmd.text) await this.runText(cmd, job.target);
        else await this.runFrame(cmd);
        job?.resolve();
      } catch (error) {
        const uncertain =
          cmd.type === "S" || (cmd.text && /^(?:U|u|B|b|s|S|q|T|:set |:reset)/.test(cmd.code));
        const detail =
          uncertain && !error.rejected
            ? cmd.code + " · outcome unknown. " + error.message
            : cmd.code + " · " + error.message;
        this.log("SYS", "", detail);
        job?.reject(Error(detail));
        if (this.stopping || this.state === "recovery") break;
        if (!error.rejected && !error.invalidPayload) {
          this.needSync = true;
          this.status("checking", "Verifying connection after a missed response");
          this.cycle = [];
          break;
        }
      }
    }
    this.origin = "system";
  }

  async synchronize() {
    this.mode = "frame";
    this.flushDecoder();
    await this.exchange(frame("P", "AP1"), "Verify command channel", {
      accept: (packet) => packet.kind === "data" && packet.payload === capabilityPage,
    });
    this.needSync = false;
  }

  async runFrame(cmd) {
    const packet = await this.exchange(cmd.wire, cmd.description, {
      key: cmd.key,
      accept: (p) => p.kind === "nack" || p.kind === (cmd.type === "S" ? "ack" : "data"),
    });
    if (packet.kind === "nack") {
      const error = Error("Rejected by UPS");
      error.rejected = true;
      throw error;
    }
    if (packet.kind === "data") {
      if (packet.decodeError) throw packet.decodeError;
      const values = packet.values;
      if (Object.keys(values).length) this.emit("sample", { key: cmd.key, values, time: this.clock.now() });
    }
  }

  flushDecoder() {
    if (this.decoder.buffer) this.log("RX", this.decoder.buffer, "Incomplete frame");
    this.decoder.buffer = "";
  }

  receive(bytes) {
    let chunk = "";
    for (const byte of bytes) chunk += String.fromCharCode(byte);
    if (this.mode === "text") {
      this.log("RX", chunk, "Text reply");
      const p = this.pending;
      if (!p || p.accept) return;
      p.text = (p.text + chunk).slice(-32768);
      if (p.until?.test(p.text)) p.finish(null, p.text);
      else if (!p.until && p.text.trim() && /[\r\n]$/.test(p.text)) {
        this.clock.clear(p.quiet);
        p.quiet = this.clock.set(() => p.finish(null, p.text), 220);
      } else this.clock.clear(p.quiet);
      return;
    }
    for (const packet of this.decoder.feed(chunk)) {
      const p = this.pending;
      const matches = p?.accept?.(packet);
      let detail = matches
        ? packet.kind === "ack"
          ? "Accepted"
          : packet.kind === "nack"
            ? "Rejected"
            : p.detail
        : "Unsolicited data";
      if (matches && packet.kind === "data" && p.key) {
        try {
          packet.values = decode(p.key, packet.payload, this.profile);
          detail = readingSummary(p.key, packet.values) || detail;
        } catch (error) {
          // A complete, delimited reply still releases the channel for the next poll.
          error.invalidPayload = true;
          packet.decodeError = error;
          detail = error.message;
        }
      }
      this.log("RX", packet.wire, detail);
      if (matches) p.finish(null, packet);
    }
  }

  exchange(wire, detail, { accept, until, key, timeout = 2600 } = {}) {
    if (this.pending) throw Error("Another serial exchange is active.");
    if (this.lostLink) return Promise.reject(Error("Serial adapter disconnected"));
    return new Promise((resolve, reject) => {
      const p = {
        accept,
        until,
        key,
        detail,
        text: "",
        finish: (error, result) => {
          if (this.pending !== p) return;
          this.pending = null;
          this.clock.clear(p.deadline);
          this.clock.clear(p.quiet);
          if (error) reject(error);
          else resolve(result);
        },
      };
      this.pending = p;
      p.deadline = this.clock.set(() => p.finish(timedOut()), timeout);
      this.log("TX", wire, detail);
      try {
        Promise.resolve(this.link.write(wire)).catch((error) => p.finish(error));
      } catch (error) {
        p.finish(error);
      }
    });
  }

  async runText(cmd, target) {
    this.status("text", "Telemetry paused for a text command");
    this.mode = "text";
    try {
      if (this.profile === "dual") {
        this.recovering = true;
        this.emit("router", true);
        await this.exchange("^X", "Open router pass-through", { until: /0=Exit/i });
        const board = target === "1" ? "Master" : "Slave";
        await this.exchange(target, "Select " + board, {
          until: new RegExp("directly to the " + board + " Model F", "i"),
        });
        await this.exchange("^X\r", "Verify board text mode", { until: /Received \^X to enter Britecom/i });
      } else await this.exchange("^X", "Open User console", { until: /User Mode enabled/i });
      if (this.stopping) throw Error("Session closing");
      const result = await this.textCommand(cmd);
      if (/unknown command|invalid response|invalid value|write failed/i.test(result))
        throw Error("UPS reported a command error");
    } finally {
      if (!this.lostLink) {
        try {
          if (this.recovering) await this.restoreRouter();
          else await this.synchronize();
          if (!this.stopping) {
            await this.runFrame(parseCommand("ST3", this.profile, "frame"));
            this.cycle = pollKeys(this.profile).filter((key) => key !== "ST3");
            this.status("live");
          }
        } catch (error) {
          this.needSync = true;
          if (!this.lostLink)
            this.status(this.recovering ? "recovery" : "checking", "Monitoring unverified. " + error.message);
          throw error;
        }
      }
    }
  }

  async textCommand(cmd) {
    if (cmd.code.startsWith(":")) {
      await this.exchange(":", "Open settings prompt", { until: /settings> /i });
      return this.exchange(cmd.wire.slice(1), cmd.description, { timeout: 6500 });
    }
    if (cmd.code === "u") {
      await this.exchange("u", cmd.description, { until: /Sure\? \(y\/n\)/i });
      const choice = await this.ask("Turn the inverter off?", ["y", "n"], "n");
      return this.exchange(choice + "\r", "Reply to UPS", { until: /Inverter Off|Command Cancelled/i });
    }
    if (cmd.code === "E") {
      const until = /<Q>uit|\*\*\* Done \*\*\*/i;
      let output = await this.exchange("E", cmd.description, { until, timeout: 15000 });
      while (!/\*\*\* Done \*\*\*/.test(output)) {
        const choice = await this.ask("Continue the event log?", ["next", "quit"], "quit");
        output = await this.exchange(choice === "quit" ? "q" : " ", "Event log reply", {
          until,
          timeout: 15000,
        });
      }
      return output;
    }
    if (cmd.code === "T") {
      await this.link.write(cmd.wire);
      this.log("TX", cmd.wire, "Panel test sent · firmware provides no acknowledgment");
      return "";
    }
    return this.exchange(cmd.wire, cmd.description, { timeout: 6000 });
  }

  ask(label, choices, cancel) {
    if (this.stopping) return Promise.resolve(cancel);
    return new Promise((resolve) => {
      const done = (value) => {
        this.clock.clear(this.promptTimer);
        this.replyTo = null;
        this.emit("prompt", null);
        resolve(value);
      };
      this.replyTo = { choices, done, cancel };
      this.promptTimer = this.clock.set(() => done(cancel), 30000);
      this.emit("prompt", { label, choices });
    });
  }

  answer(value) {
    if (!this.replyTo?.choices.includes(value)) return false;
    this.replyTo.done(value);
    return true;
  }

  async restoreRouter() {
    this.mode = "text";
    try {
      await this.exchange("0", "Return router to monitoring", {
        until: /connected back to (?:SNMP|Upsilon) mode/i,
        timeout: 1600,
      });
    } catch (error) {
      if (this.lostLink) throw error;
      // A router that already restarted in framed mode can discard the exit byte.
      this.log("SYS", "", "Checking the router's framed response");
    }
    await this.synchronize();
    this.recovering = false;
    this.emit("router", false);
  }

  lost(error) {
    if (this.lostLink) return;
    this.lostLink = true;
    this.stopping = true;
    this.clock.clear(this.timer);
    this.pending?.finish(error);
    if (this.replyTo) this.replyTo.done(this.replyTo.cancel);
    this.flushDecoder();
    this.discardQueue();
    this.status(
      "closed",
      this.recovering
        ? "Router return unverified. Reconnect this adapter to restore monitoring."
        : error.message,
    );
    void this.link.close().catch(() => {});
  }

  discardQueue() {
    this.cycle = [];
    for (const job of this.queue.splice(0)) job.reject(Error("Session closed before transmission"));
  }

  async stop() {
    if (this.state === "closed") return;
    this.stopping = true;
    this.clock.clear(this.timer);
    this.discardQueue();
    if (this.replyTo) this.replyTo.done(this.replyTo.cancel);
    else if (this.mode === "frame") this.pending?.finish(Error("Session closing"));
    // Let an in-flight text command return the router before releasing the port.
    await this.running;
    await this.link.close();
    this.flushDecoder();
    this.status(
      "closed",
      this.recovering ? "Router return unverified. Reconnect this adapter." : "Session ended",
    );
  }
}
