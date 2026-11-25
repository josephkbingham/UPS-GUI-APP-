import { capabilityPage, frame } from "./protocol.js";

// An in-memory serial peer. The session, parsers, and polling scheduler are shared with hardware.
export class DemoLink {
  constructor(profile, { latency = 24 } = {}) {
    this.profile = profile;
    this.latency = latency;
    this.mode = "frame";
    this.timers = new Set();
    this.tick = 0;
    this.bypass = false;
    this.output = true;
    this.saved = { PSD: "-1", STD: "-1", SDA: "1", UID: "1", BTS: "0" };
  }
  start(onData) {
    this.onData = onData;
  }
  async write(wire) {
    const response = this.respond(wire);
    if (!response) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const bytes = new TextEncoder().encode(response);
      this.onData(bytes.slice(0, 3));
      this.onData(bytes.slice(3));
    }, this.latency);
    this.timers.add(timer);
  }
  respond(wire) {
    const dual = this.profile === "dual";
    if (this.mode === "frame" && wire === "^X") {
      this.mode = dual ? "router" : "text";
      return dual
        ? "\r\nYou are now connected to SNMP bypass. 1=Master,2=Slave,0=Exit\r\n"
        : "\r\nUser Mode enabled\r\n";
    }
    if (dual && this.mode !== "frame" && wire === "0") {
      this.mode = "frame";
      this.prompt = null;
      return "You are now connected back to SNMP mode\r\n";
    }
    if (this.mode === "router" && ["1", "2"].includes(wire)) {
      this.board = wire === "1" ? "Master" : "Slave";
      return "You are now connected directly to the " + this.board + " Model F board\r\n";
    }
    if (this.mode === "router" && wire === "^X\r") {
      this.mode = "text";
      return "COM_WAITING: Received ^X to enter Britecom\r\n";
    }
    if (this.mode === "text" && wire.startsWith("^P") && !dual) this.mode = "frame";
    if (this.mode === "text") return this.textReply(wire);
    if (this.mode !== "frame") return "";
    const key = wire.slice(5, 8);
    if (wire.startsWith("^S")) {
      this.saved[key] = wire.slice(8);
      return "^1";
    }
    if (!wire.startsWith("^P")) return "^0";
    if (key === "ST3") this.tick++;
    const drift = Math.round(15 * Math.sin(this.tick / 3));
    const amps = this.output ? 18 + Math.round(drift / 5) : 0;
    const pct = this.output ? 42 + Math.round(drift / 4) : 0;
    const upsilon = this.profile === "upsilon";
    const tenthV = (dual ? 2200 : 1150) + drift;
    const output = [
      this.bypass ? 2 : this.output ? 0 : 5,
      600,
      1,
      this.output ? tenthV : 0,
      upsilon ? pct * 10 : amps,
      this.output ? Math.round((amps * tenthV) / 100) : 0,
      upsilon ? Math.floor(amps / 10) : pct,
    ];
    const values = {
      AP1: capabilityPage,
      AP2: "47,51,54,55,56,58,59,60,61,62,63,65,68,69,72,73,76,77,80,82,83,84,85,88,89",
      MAN: "INTELLIPOWER",
      MOD: dual ? "5000" : "FA10273",
      VER: dual ? "1.1.14 DEMO" : "1.0.158 DEMO",
      NOM: dual ? "440,600,220,600,5000,4000,1,1,374,506" : "115,600,115,600,600,500,1,2,100,140",
      ST1: [0, 2, 0, 0, 38, upsilon ? 960 : 96, dual ? 675 : 540, 3, 26].join(","),
      ST2: dual ? ",1,600,4400,,,600,4397" : ",1,600," + (1161 + drift),
      ST3: output.join(","),
      ST4: this.bypass ? "600,1," + tenthV + ",0,0" : "0,0,0,0,0",
      ST5: dual
        ? [0, 0, 0, 0, "", this.output ? 0 : 1, "", 0].join(",")
        : [0, 0, 0, 0, 0, this.output ? 0 : 1, "", "", "", 0, "", "", "", "", ""].join(","),
      XD1: "3,3900,34,1,240",
      XD2: "67.51,0.3,0,67.48,0.2,0,450000,449000",
      ATR: "1",
      UBR: "9600",
      STR: "1",
      ...this.saved,
    };
    return Object.hasOwn(values, key) ? frame("D", values[key]) : "^0";
  }
  textReply(wire) {
    if (this.prompt === "off") {
      this.prompt = null;
      if (wire === "y\r") this.output = false;
      return wire === "y\r" ? "Inverter Off\r\n" : "Command Cancelled\r\n";
    }
    if (this.prompt === "event") {
      this.prompt = null;
      return "*** Done ***\r\n";
    }
    if (this.prompt === "settings") {
      this.prompt = null;
      return wire.trim().startsWith("set ")
        ? "Settings saved\r\n"
        : "Profile: FA10273\r\n  autostart: on\r\n  baud: 9600\r\n";
    }
    if (wire === ":") {
      this.prompt = "settings";
      return "settings> ";
    }
    if (wire === "u") {
      this.prompt = "off";
      return "Sure? (y/n)\r\n";
    }
    if (wire === "E") {
      this.prompt = "event";
      return "Event 1: Utility restored\r\nPress any key, <Q>uit\r\n";
    }
    if (wire === "U") this.output = true;
    if (wire === "B" || wire === "b") this.bypass = wire === "B";
    const replies = {
      H: "USER HELP\r\nUPS, U=on, u=off",
      h: "USER HELP\r\nUPS, U=on, u=off",
      I: "INTELLIPOWER " + (this.board || "FA10273"),
      "!": "Auto On,Auto Off,Float,Auto Off,Sync,Auto Fast",
      "&": "390,24,2",
      ")": "96.00",
      "(": "Auto,,",
      "~": "0 days 01:20:00.000",
      "*": "Last event: Utility restored",
      "+": "Previous event",
      "-": "Next event",
      "=": "Current event",
      U: "Inverter On",
      B: "Bypass Auto On",
      b: "Bypass Auto",
      s: "Sonalert beep",
      S: "Sonalert on",
      q: "Sonalert off",
      y: "12:30:00",
      T: "",
    };
    return (replies[wire] ?? "Unknown command") + "\r\n";
  }
  async close() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
