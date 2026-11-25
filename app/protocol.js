export const profiles = {
  model: "FA10273 · Model F",
  upsilon: "Model F · UPSilon",
  dual: "FA10642 · Dual board",
};

export const capabilityPage = "7,8,10,14,16,17,18,19,20,22,24,36,37,38,39,40,43,46";

const polls = {
  ST3: "Read output power and UPS state",
  ST1: "Read battery and runtime",
  ST2: "Read input lines",
  ST5: "Read reported alarms",
  ST4: "Read bypass status",
  XD1: "Read charger, bus and heatsink",
  XD2: "Read both battery strings",
  MAN: "Read manufacturer",
  MOD: "Read model",
  VER: "Read firmware version",
  NOM: "Read nominal ratings",
  ATR: "Read autostart setting",
  BTS: "Read battleshort status",
  PSD: "Read shutdown delay",
  STD: "Read startup delay",
  SDA: "Read shutdown type",
  UID: "Read unit ID",
  UBR: "Read reported baud rate",
  STR: "Read fixed test summary",
  AP1: "Read capability page 1",
  AP2: "Read capability page 2",
};

const setters = {
  PSD: ["Schedule shutdown", -1, 999, "seconds, −1 cancels"],
  STD: ["Schedule startup", -1, 999, "seconds, −1 cancels"],
  RWD: ["Schedule reboot", -1, 999, "seconds, −1 cancels"],
  SDA: ["Set shutdown type", 1, 2, "type"],
  BTS: ["Set battleshort", 0, 1, "0 off, 1 on"],
  UID: ["Save unit ID", 0, 999, "unit ID"],
};

const userCommands = {
  H: "Show user help",
  h: "Show user help",
  I: "Identify unit",
  "!": "Read converter modes",
  "&": "Read DC supply measurements",
  ")": "Read battery charge",
  "(": "Read audible alarm mode",
  "~": "Read uptime",
  "*": "Read last event",
  "+": "Read previous event",
  "-": "Read next event",
  "=": "Read current event",
  E: "Browse the event log",
  U: "Turn inverter on",
  u: "Turn inverter off with a prompt",
  B: "Enable automatic bypass",
  b: "Return bypass to automatic control",
  s: "Sound one beep",
  S: "Turn audible signal on",
  q: "Silence audible signal",
  y: "Read clock",
  T: "Run front panel light test",
};

const settings = {
  autostart: ["on", "off"],
  sync: ["on", "off"],
  freq_range: ["narrow", "wide"],
  input_transfer: ["85/95", "85/90", "80/85", "100/107"],
  display: ["vertical", "horizontal"],
  baud: ["1200", "2400", "4800", "9600"],
};

export function catalog(profile, mode) {
  if (!Object.hasOwn(profiles, profile)) throw Error("Select a board profile.");
  const dual = profile === "dual";
  if (mode === "text") {
    const items = Object.entries(userCommands).map(([code, description]) => ({
      code,
      description,
      kind: "Text",
    }));
    if (!dual) {
      for (const [code, description] of Object.entries({
        ":show": "Read active settings",
        ":status": "Read active settings",
        ":profile": "Read product profile",
        ":defaults": "Read default settings",
        ":help": "Show settings help",
        ":reset": "Restore saved defaults",
      }))
        items.push({ code, description, kind: "Text" });
      for (const [key, values] of Object.entries(settings))
        for (const value of values)
          items.push({
            code: ":set " + key + " " + value,
            description: "Save " + key.replaceAll("_", " ") + " setting",
            kind: "Write",
          });
    }
    return items;
  }
  const result = Object.entries(polls)
    .filter(([key]) => (key === "XD2" ? dual : !(dual && key === "BTS")))
    .map(([code, description]) => ({ code, description, kind: "Read" }));
  for (const [key, [description, min, max, unit]] of Object.entries(setters)) {
    if (dual && !["PSD", "STD", "UID"].includes(key)) continue;
    result.push({ code: "SET " + key, description, kind: "Write", hint: min + "…" + max + " " + unit });
  }
  return result;
}

export function suggestions(input, profile, mode) {
  const needle = input.trim().toLowerCase();
  const items = catalog(profile, mode);
  const exact = items.filter((item) => item.code === input.trim());
  const prefix = items.filter((item) => !exact.includes(item) && item.code.toLowerCase().startsWith(needle));
  const other = items.filter(
    (item) =>
      !exact.includes(item) &&
      !prefix.includes(item) &&
      (item.code + " " + item.description).toLowerCase().includes(needle),
  );
  return [...exact, ...prefix, ...other];
}

export function frame(type, payload) {
  return "^" + type + String(payload.length).padStart(3, "0") + payload;
}

export function parseCommand(input, profile, mode) {
  if (/[^\x20-\x7e]/.test(input)) throw Error("Enter one printable ASCII command.");
  const line = input.trim();
  const items = catalog(profile, mode);
  if (mode === "text") {
    const item = items.find((entry) => entry.code === line);
    if (!item || line.length > 49) throw Error("Choose a supported, case-sensitive User command.");
    return { ...item, text: true, wire: line + (line.startsWith(":") ? "\r" : "") };
  }
  let key, value, type;
  if (line.startsWith("^")) {
    const match = /^\^([PS])(\d{3})([A-Z0-9]{3})(.*)$/.exec(line);
    if (!match || Number(match[2]) !== line.length - 5) throw Error("Frame length or header is invalid.");
    [, type, , key, value] = match;
  } else {
    const match = /^(?:(POLL|SET)\s+)?([A-Z0-9]{3})(?:\s+(\S+))?$/i.exec(line);
    if (!match) throw Error("Enter a command such as ST3 or SET PSD 30.");
    key = match[2].toUpperCase();
    value = match[3] || "";
    type = match[1]?.toUpperCase() === "SET" || (!match[1] && value) ? "S" : "P";
  }
  const item = items.find((entry) => entry.code === (type === "P" ? key : "SET " + key));
  if (!item) throw Error("This command is unavailable for this board profile.");
  if (type === "S") {
    const [, min, max] = setters[key];
    if (!/^(?:0|[1-9]\d*|-[1-9]\d*)$/.test(value) || Number(value) < min || Number(value) > max)
      throw Error(key + " requires a whole number from " + min + " to " + max + ".");
  } else if (value) throw Error("Read commands take no arguments.");
  return { ...item, key, type, wire: frame(type, key + value) };
}

// ^D replies carry a byte count and no command identifier or line terminator.
export class FrameDecoder {
  buffer = "";
  feed(chunk) {
    this.buffer += chunk;
    const packets = [];
    while (this.buffer) {
      const s = this.buffer;
      let size, kind;
      if (s[0] !== "^") {
        const start = s.indexOf("^");
        size = start < 0 ? s.length : start;
        kind = "noise";
      } else if (s.length === 1) break;
      else if (s[1] === "0" || s[1] === "1") {
        size = 2;
        kind = s[1] === "1" ? "ack" : "nack";
      } else if (s[1] === "D" && /^\d*$/.test(s.slice(2, 5))) {
        if (s.length < 5) break;
        size = 5 + Number(s.slice(2, 5));
        if (s.length < size) break;
        kind = "data";
      } else {
        size = 1;
        kind = "noise";
      }
      packets.push({ kind, wire: s.slice(0, size), payload: kind === "data" ? s.slice(5, size) : "" });
      this.buffer = s.slice(size);
    }
    return packets;
  }
}

const alarmNames = [
  "Overtemperature",
  "Input bad / on battery",
  "Inverter fault",
  "Output overload",
  "Bypass fault",
  "Output off as requested",
  "Shutdown",
  "Charger failure",
  "System off",
  "Cabinet fan failure",
  "Fuse failure",
  "General fault",
  "Awaiting power",
  "Shutdown pending",
  "Shutdown imminent",
];
const sourceNames = {
  0: "On utility",
  1: "On battery",
  2: "On bypass",
  4: "External DC",
  5: "Other / off / init",
};
export const groupKeys = ["ST3", "ST1", "ST2", "ST5", "ST4", "XD1"];
export const pollKeys = (profile) => (profile === "dual" ? [...groupKeys, "XD2"] : [...groupKeys]);

export function decode(key, payload, profile) {
  const dual = profile === "dual";
  const upsilon = profile === "upsilon";
  const fields = payload.split(",");
  const number = (i, scale = 1) => {
    const field = fields[i];
    if (field === "") return null;
    if (!/^-?\d+(?:\.\d+)?$/.test(field ?? ""))
      throw Error("Invalid numeric field " + (i + 1) + " in " + key);
    const n = Number(field) / scale;
    if (!Number.isFinite(n)) throw Error("Invalid reading in " + key);
    return n;
  };
  const lengths = { ST1: 9, ST2: dual ? 8 : 4, ST3: 7, ST4: 5, ST5: dual ? 8 : 15, XD1: 5, XD2: 8 };
  if (Object.hasOwn(lengths, key) && fields.length !== lengths[key])
    throw Error("Unexpected field count for " + key);
  switch (key) {
    case "ST3": {
      const code = number(0);
      return {
        source: sourceNames[code] ?? (code == null ? "Unknown" : "Unknown (" + code + ")"),
        sourceCode: code,
        outputHz: number(1, 10),
        outputV: number(3, 10),
        outputA: upsilon ? number(6) : number(4, 10),
        watts: number(5),
        load: upsilon ? number(4, 10) : number(6),
      };
    }
    case "ST1":
      return {
        batteryCondition: number(0),
        batteryStatus: number(1),
        chargeMode: number(2),
        onBatterySeconds: number(3),
        runtime: number(4),
        charge: number(5, upsilon ? 10 : 1),
        batteryV: number(6, 10),
        batteryA: number(7, 10),
        ambient: number(8),
      };
    case "ST2":
      return {
        inputHz: number(2, 10),
        inputV: number(3, 10),
        ...(dual ? { input2Hz: number(6, 10), input2V: number(7, 10) } : {}),
      };
    case "ST4":
      return { bypassHz: number(0, 10), bypassV: number(2, 10) };
    case "ST5": {
      if (!fields.every((f) => f === "" || f === "0" || f === "1")) throw Error("Invalid alarm field");
      const implemented = dual ? [0, 1, 2, 3, 5, 7] : [0, 1, 2, 3, 5, 9, 11];
      return {
        alarms: implemented.filter((i) => fields[i] === "1").map((i) => alarmNames[i]),
        reportedAlarms: implemented.filter((i) => fields[i] !== "").length,
      };
    }
    case "XD1":
      return { chargerA: number(0, 10), busV: number(1, 10), sink: number(2), supplyV: number(4, 10) };
    case "XD2":
      return {
        string1V: number(0),
        string1ChargeA: number(1),
        string1A: number(2),
        string2V: number(3),
        string2ChargeA: number(4),
        string2A: number(5),
      };
    case "MOD":
      return { model: payload };
    case "MAN":
      return { manufacturer: payload };
    case "VER":
      return { firmware: payload };
    default:
      return {};
  }
}

export function readingSummary(key, values) {
  const show = (name, unit) => (values[name] == null ? "—" : values[name] + " " + unit);
  switch (key) {
    case "ST3":
      return [values.source, show("outputV", "V"), show("watts", "W"), show("load", "%")].join(" · ");
    case "ST1":
      return [show("charge", "%"), show("batteryV", "V"), show("runtime", "min remaining")].join(" · ");
    case "ST2":
      return ["Input", show("inputV", "V"), show("inputHz", "Hz")].join(" · ");
    case "ST4":
      return "Bypass · " + show("bypassV", "V");
    case "ST5":
      return (
        values.alarms.join(", ") ||
        (values.reportedAlarms ? "No active alarms reported" : "Alarm data unavailable")
      );
    case "XD1":
      return "DC bus " + show("busV", "V") + " · heatsink " + show("sink", "°C");
    case "XD2":
      return "Master " + show("string1V", "V") + " · slave " + show("string2V", "V");
    default:
      return "";
  }
}
