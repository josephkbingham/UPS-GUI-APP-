const encoder = new TextEncoder();

export class WebSerialLink {
  static async open(baudRate) {
    if (!navigator.serial)
      throw Error("Web Serial is unavailable. Open the local launcher in desktop Edge or Chrome.");
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
    return new WebSerialLink(port);
  }
  constructor(port) {
    this.port = port;
  }
  start(onData, onLost) {
    this.reader = this.port.readable.getReader();
    try {
      this.writer = this.port.writable.getWriter();
    } catch (error) {
      this.reader.releaseLock();
      this.reader = null;
      throw error;
    }
    this.reading = (async () => {
      let failure;
      try {
        while (!this.closing) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value?.length) onData(value);
        }
      } catch (error) {
        failure = error;
      } finally {
        this.reader.releaseLock();
      }
      if (!this.closing) onLost(failure || Error("Serial adapter disconnected"));
    })();
  }
  async write(wire) {
    if (this.writing || this.closing) throw Error("Serial writer is busy or closing");
    this.writing = this.writer.write(encoder.encode(wire));
    try {
      await this.writing;
    } finally {
      this.writing = null;
    }
  }
  close() {
    if (!this.closing) this.closing = this.release();
    return this.closing;
  }
  async release() {
    try {
      await this.reader?.cancel();
    } catch {
      /* Device may already be unplugged. */
    }
    await this.reading;
    if (this.writing) {
      try {
        await this.writer.abort();
      } catch {
        /* The adapter may already have closed the writable stream. */
      }
    }
    this.writer?.releaseLock();
    await this.port.close();
  }
}
