import { profiles, suggestions } from "./protocol.js";
import { UpsSession, refreshSeconds } from "./session.js";
import { WebSerialLink } from "./serial.js";
import { DemoLink } from "./demo.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
function load(key, fallback) {
  try {
    return localStorage.getItem("ups-console." + key) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem("ups-console." + key, value);
  } catch {
    /* Storage can be disabled. */
  }
}
let seconds;
try {
  seconds = refreshSeconds(load("refresh", "2"));
} catch {
  seconds = 2;
}
$("refresh").value = String(seconds);
const storedProfile = load("profile", "model");
$("profile").value = Object.hasOwn(profiles, storedProfile) ? storedProfile : "model";
$("baud").value = ["1200", "2400", "4800", "9600"].includes(load("baud", "")) ? load("baud") : "9600";
let session,
  activeProfile = $("profile").value,
  demo = false,
  state = "closed",
  busy = false,
  opening = false;
let view = "power",
  filter = "all",
  menuItems = [],
  highlight = 0,
  prompt = null,
  historyIndex = 0;
let renderPending = false,
  logPending = false,
  logReset = false,
  lastRendered = 0,
  sequence = 0;
let records = [],
  samples = {},
  trend = [];
const history = [];
const time = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const fmtTime = (ms) => time.format(ms);
const fmt = (value, digits = 0) => (typeof value === "number" ? value.toFixed(digits) : "—");
const latestTime = () =>
  Math.max(
    0,
    ...Object.values(samples)
      .filter((s) => Object.keys(s.values).length > 1)
      .map((s) => s.time),
  );
const stale = (key) =>
  !!samples[key] && (state !== "live" || Date.now() - samples[key].time > Math.max(5000, seconds * 2500));
const values = (key) => samples[key]?.values || {};
const group = (name, fields) => ({ name, fields });
const field = (key, metric, unit = "", digits = 0) => ({ key, metric, unit, digits });

function setMessage(text = "") {
  $("message").textContent = text;
  $("message").hidden = !text;
}
function displayField(f) {
  if (!f) {
    const cell = el("td", "—");
    cell.title = "This reading is not reported by the selected profile";
    return cell;
  }
  const value = values(f.key)[f.metric];
  const td = el("td", value == null ? "—" : fmt(value, f.digits) + (f.unit ? " " + f.unit : ""));
  if (samples[f.key]) {
    td.title = "Last received " + fmtTime(samples[f.key].time);
    if (stale(f.key)) {
      td.className = "stale";
      td.title += " · stale";
    }
  }
  return td;
}
function table(headings, rows) {
  const t = el("table", null, "reading-table");
  const head = t.createTHead().insertRow();
  for (const title of headings) head.append(el("th", title));
  const body = t.createTBody();
  for (const { name, fields } of rows) {
    const row = body.insertRow();
    row.append(el("td", name), ...fields.map(displayField));
  }
  return t;
}
function renderTable() {
  const tables = [];
  if (view === "power") {
    tables.push(
      table(
        ["AC measurements", "Input", "Output"],
        [
          group("Voltage", [field("ST2", "inputV", "V", 1), field("ST3", "outputV", "V", 1)]),
          group("Frequency", [field("ST2", "inputHz", "Hz", 1), field("ST3", "outputHz", "Hz", 1)]),
          group("Current", [null, field("ST3", "outputA", "A", 1)]),
          group("Real power", [null, field("ST3", "watts", "W")]),
        ],
      ),
    );
    if (activeProfile === "dual")
      tables.push(
        table(
          ["Second input", "Reading"],
          [
            group("Voltage", [field("ST2", "input2V", "V", 1)]),
            group("Frequency", [field("ST2", "input2Hz", "Hz", 1)]),
          ],
        ),
      );
    tables.push(
      table(
        ["DC & thermal", "Reading"],
        [
          group("DC bus", [field("XD1", "busV", "V", 1)]),
          group("Controller supply", [field("XD1", "supplyV", "V", 1)]),
          group("Heatsink", [field("XD1", "sink", "°C")]),
          group("Ambient", [field("ST1", "ambient", "°C")]),
        ],
      ),
    );
  } else if (view === "battery") {
    tables.push(
      table(
        ["Battery measurements", "Reading"],
        [
          group("Battery voltage", [field("ST1", "batteryV", "V", 1)]),
          group("Battery / charge current", [field("ST1", "batteryA", "A", 1)]),
          group("Charger current", [field("XD1", "chargerA", "A", 1)]),
          group("Time on battery", [field("ST1", "onBatterySeconds", "s")]),
          group("Remaining charge", [field("ST1", "charge", "%", activeProfile === "upsilon" ? 1 : 0)]),
          group("Estimated runtime", [field("ST1", "runtime", "min")]),
        ],
      ),
    );
    if (activeProfile === "dual")
      tables.push(
        table(
          ["Battery strings", "Master", "Slave"],
          [
            group("Voltage", [field("XD2", "string1V", "V", 2), field("XD2", "string2V", "V", 2)]),
            group("Charge current", [
              field("XD2", "string1ChargeA", "A", 2),
              field("XD2", "string2ChargeA", "A", 2),
            ]),
            group("Battery current", [field("XD2", "string1A", "A", 2), field("XD2", "string2A", "A", 2)]),
          ],
        ),
      );
  } else {
    const alarm = values("ST5");
    const labels = alarm.alarms?.length
      ? alarm.alarms
      : [alarm.reportedAlarms ? "No active alarms reported" : "Awaiting alarm data"];
    for (const text of labels)
      tables.push(el("div", text, "alarm-note" + (alarm.alarms?.length ? " active" : "")));
    if (samples.ST5)
      tables.push(
        el("small", (stale("ST5") ? "Stale · " : "") + "Last alarm report " + fmtTime(samples.ST5.time)),
      );
  }
  $("readings").replaceChildren(...tables);
  $("readings").setAttribute("aria-labelledby", "tab-" + view);
  for (const tab of document.querySelectorAll("[data-view]")) {
    tab.setAttribute("aria-selected", String(tab.dataset.view === view));
    tab.tabIndex = tab.dataset.view === view ? 0 : -1;
  }
}
function drawTrend() {
  const canvas = $("load-trend"),
    dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#414b41";
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(0, h - 2);
  ctx.lineTo(w, h - 2);
  ctx.stroke();
  if (!trend.length) return;
  const low = Math.min(...trend) - 4,
    high = Math.max(...trend) + 4;
  ctx.setLineDash([]);
  ctx.strokeStyle = stale("ST3") ? "#7e897d" : "#b7d49c";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  trend.forEach((v, i) => {
    const x = 2 + (i * (w - 4)) / Math.max(1, trend.length - 1),
      y = h - 2 - ((v - low) * (h - 4)) / (high - low);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    if (trend.length === 1) ctx.lineTo(x + 2, y);
  });
  ctx.stroke();
}
function render() {
  renderPending = false;
  const out = values("ST3"),
    bat = values("ST1"),
    alarms = values("ST5").alarms;
  const live = state === "live",
    connected = state !== "closed";
  $("source").textContent = out.source ?? "Awaiting data";
  $("source-note").textContent =
    samples.ST3 && stale("ST3") ? "Stale · " + fmtTime(samples.ST3.time) : "Reported output source";
  $("state-card").dataset.tone = live
    ? { 0: "utility", 1: "battery", 2: "bypass" }[out.sourceCode] || ""
    : "";
  $("load").textContent = fmt(out.load, activeProfile === "upsilon" ? 1 : 0);
  $("charge").textContent = fmt(bat.charge, activeProfile === "upsilon" ? 1 : 0);
  $("runtime").textContent = fmt(bat.runtime);
  $("charge-fill").style.width = Math.max(0, Math.min(100, bat.charge ?? 0)) + "%";
  for (const card of document.querySelectorAll(".metric[data-group]")) {
    card.dataset.stale = String(stale(card.dataset.group));
    card.title = samples[card.dataset.group]
      ? (stale(card.dataset.group) ? "Stale · " : "") +
        "Received " +
        fmtTime(samples[card.dataset.group].time)
      : "";
  }
  $("alarm-count").textContent = alarms?.length ?? "";
  $("alarm-banner").hidden = !alarms?.length;
  if (alarms?.length)
    $("alarm-banner").textContent =
      (stale("ST5") ? "Last alarm report · " : "Active alarms · ") + alarms.join(" · ") + "  ›";
  const last = latestTime();
  $("last-sample").textContent = last
    ? (state === "text" ? "Paused · " : !live || stale("ST3") ? "Stale · " : "Updated ") + fmtTime(last)
    : "Awaiting readings";
  const model = values("MOD").model;
  const identity = [model && !profiles[activeProfile].includes(model) ? model : "", values("VER").firmware]
    .filter(Boolean)
    .join(" / ");
  $("unit-label").textContent =
    connected || last
      ? (demo ? "Demo · " : "") + profiles[activeProfile] + (identity ? "  ·  " + identity : "")
      : "No UPS connected";
  const badge = $("connection-state");
  badge.dataset.state = live ? (demo ? "demo" : "live") : connected ? "waiting" : "closed";
  badge.querySelector("span").textContent = {
    closed: "Disconnected",
    live: demo ? "Demo session" : "Connected",
    text: "Text session",
    checking: "Checking link",
    recovery: "Recovery needed",
  }[state];
  $("connect").textContent = connected ? "Disconnect" : "Connect UPS";
  $("connect").disabled = opening;
  $("demo").hidden = connected;
  $("target-label").hidden = !(activeProfile === "dual" && $("mode").value === "text");
  $("mode-note").textContent =
    activeProfile === "dual" && $("mode").value === "text"
      ? state === "text"
        ? "Router control paused"
        : "Router control pauses during a text command"
      : state === "text"
        ? "Polling paused"
        : "";
  $("mode").disabled = busy;
  $("target").disabled = busy;
  $("send").disabled = !prompt && (!live || busy);
  $("port-label").textContent = connected
    ? (demo ? "Demo adapter" : "Serial adapter") + " · " + $("baud").value + " baud · 8N1"
    : "Serial port closed";
  $("poll-label").textContent = "Refresh interval · " + seconds + " s";
  renderTable();
  drawTrend();
}
function invalidate() {
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(render);
  }
}
function visibleRaw(wire) {
  return wire.replace(/[\x00-\x1f\x7f-\xff]/g, (ch) =>
    ch === "\r" ? "␍" : ch === "\n" ? "␊" : "\\x" + ch.charCodeAt(0).toString(16).padStart(2, "0"),
  );
}
function addRecord(record) {
  records.push({ ...record, id: ++sequence });
  if (records.length > 600) records.shift();
  queueLog();
}
function queueLog(reset = false) {
  logReset ||= reset;
  if (!logPending) {
    logPending = true;
    requestAnimationFrame(renderLog);
  }
}
function renderLog() {
  logPending = false;
  const log = $("log");
  if (logReset) {
    log.replaceChildren();
    lastRendered = 0;
    logReset = false;
  }
  const rows = records.filter((r) => r.id > lastRendered && (filter === "all" || r.origin === "manual"));
  if (rows.length) {
    log.querySelector(".log-empty")?.remove();
    const fragment = document.createDocumentFragment();
    for (const r of rows) {
      const div = el("div", null, "log-row");
      div.dataset.dir = r.direction;
      div.dataset.id = r.id;
      const content = el("div", r.wire ? visibleRaw(r.wire) : r.detail, "wire");
      if (r.wire && r.detail) content.append(el("small", r.detail, "log-detail"));
      const stamp = fmtTime(r.time) + "." + String(r.time % 1000).padStart(3, "0");
      div.append(el("time", stamp), el("span", r.direction, "direction"), content);
      fragment.append(div);
    }
    log.append(fragment);
  }
  lastRendered = sequence;
  while (
    log.firstElementChild?.dataset.id &&
    Number(log.firstElementChild.dataset.id) < (records[0]?.id ?? 0)
  )
    log.firstElementChild.remove();
  if (!log.childElementCount) {
    const empty = el("div", null, "log-empty");
    empty.append(
      el("span", "›_"),
      el("b", filter === "manual" ? "No manual traffic yet" : "Waiting for serial traffic"),
      el(
        "small",
        filter === "manual"
          ? "Send a command to see its exchange."
          : "Transmitted commands and UPS replies appear here.",
      ),
    );
    log.append(empty);
  }
  if ($("follow").checked) log.scrollTop = log.scrollHeight;
}
function showPrompt(data) {
  prompt = data;
  const box = $("prompt");
  box.replaceChildren();
  box.hidden = !data;
  if (data) {
    box.append(el("strong", data.label));
    for (const choice of data.choices) {
      const button = el("button", choice);
      button.onclick = () => session?.answer(choice);
      box.append(button);
    }
    hideMenu();
  }
  invalidate();
}
function publishEvent(kind, data) {
  if (kind === "log") addRecord(data);
  else if (kind === "sample") {
    samples[data.key] = data;
    if (data.key === "ST3" && data.values.load != null) {
      trend.push(data.values.load);
      if (trend.length > 45) trend.shift();
    }
    invalidate();
  } else if (kind === "status") {
    state = data.state;
    if (data.detail)
      addRecord({ direction: "SYS", wire: "", detail: data.detail, origin: "system", time: Date.now() });
    setMessage(
      ["checking", "recovery"].includes(state) || (state === "closed" && data.detail !== "Session ended")
        ? data.detail
        : "",
    );
    invalidate();
  } else if (kind === "prompt") showPrompt(data);
  else if (kind === "router" && !demo) save("router-interrupted", data ? "1" : "0");
}
function profileChange() {
  $("recover-label").hidden = $("profile").value !== "dual";
  $("recover").checked = load("router-interrupted", "0") === "1";
}
async function openSession(simulated) {
  if (opening || state !== "closed") return;
  opening = true;
  $("select-port").disabled = true;
  $("dialog-demo").disabled = true;
  $("dialog-error").textContent = "";
  let link;
  try {
    const profile = $("profile").value;
    link = simulated ? new DemoLink(profile) : await WebSerialLink.open(Number($("baud").value));
    demo = simulated;
    activeProfile = profile;
    samples = {};
    trend = [];
    records = [];
    queueLog(true);
    save("profile", profile);
    save("baud", $("baud").value);
    const nextSession = new UpsSession(link, {
      profile, seconds,
      emit(kind, data) {
        if (session === nextSession) publishEvent(kind, data);
      },
    });
    session = nextSession;
    $("command-error").textContent = "";
    setMessage();
    showPrompt(null);
    session.start({ recoverRouter: !simulated && profile === "dual" && $("recover").checked });
    $("connection-dialog").close();
    hideMenu();
  } catch (error) {
    await link?.close().catch(() => {});
    const detail =
      error.name === "NotFoundError"
        ? "Port selection cancelled."
        : error.message || "Could not open the serial port.";
    $("dialog-error").textContent = detail;
    if (!$("connection-dialog").open) setMessage(detail);
  } finally {
    opening = false;
    $("select-port").disabled = false;
    $("dialog-demo").disabled = false;
    invalidate();
  }
}
$("connect").onclick = async () => {
  if (state === "closed") {
    profileChange();
    $("dialog-error").textContent = "";
    $("connection-dialog").showModal();
  } else {
    opening = true;
    invalidate();
    try {
      await session.stop();
    } catch (error) {
      setMessage(error.message);
    } finally {
      opening = false;
      invalidate();
    }
  }
};
$("select-port").onclick = () => openSession(false);
$("demo").onclick = $("dialog-demo").onclick = () => openSession(true);
$("profile").onchange = profileChange;
$("dismiss").onclick = () => $("connection-dialog").close();
$("alarm-banner").onclick = () => {
  $("tab-alarms").click();
  $("tab-alarms").focus();
};
function updateRefresh() {
  try {
    const next = refreshSeconds($("refresh").value);
    if (next !== seconds) {
      session?.setInterval(next);
      seconds = next;
      save("refresh", String(next));
    }
    $("refresh").setCustomValidity("");
    invalidate();
  } catch (error) {
    $("refresh").setCustomValidity(error.message);
    $("refresh").reportValidity();
  }
}
$("refresh").oninput = () => $("refresh").setCustomValidity("");
$("refresh").onchange = updateRefresh;
$("refresh-form").onsubmit = (ev) => {
  ev.preventDefault();
  updateRefresh();
};
for (const tab of document.querySelectorAll("[data-view]")) {
  tab.onclick = () => {
    view = tab.dataset.view;
    render();
  };
  tab.onkeydown = (e) => {
    if (!["ArrowRight", "ArrowLeft"].includes(e.key)) return;
    e.preventDefault();
    const tabs = [...document.querySelectorAll("[data-view]")];
    const next = tabs[(tabs.indexOf(tab) + (e.key === "ArrowRight" ? 1 : 2)) % 3];
    next.click();
    next.focus();
  };
}
function setFilter(next) {
  filter = next;
  $("all-traffic").setAttribute("aria-pressed", String(next === "all"));
  $("manual-traffic").setAttribute("aria-pressed", String(next === "manual"));
  queueLog(true);
}
$("all-traffic").onclick = () => setFilter("all");
$("manual-traffic").onclick = () => setFilter("manual");
$("clear").onclick = () => {
  records = [];
  queueLog(true);
};
$("follow").onchange = () => queueLog();

const command = $("command"),
  menu = $("suggestions");
function hideMenu() {
  menu.hidden = true;
  command.setAttribute("aria-expanded", "false");
  command.removeAttribute("aria-activedescendant");
}
function complete(item) {
  if (!item) return;
  command.value = item.code + (item.hint ? " " : "");
  $("command-error").textContent = item.hint || "";
  hideMenu();
  command.focus();
}
function paintMenu() {
  menu.replaceChildren();
  for (const [i, item] of menuItems.entries()) {
    const opt = el("button", null, "suggest");
    opt.type = "button";
    opt.role = "option";
    opt.tabIndex = -1;
    opt.id = "suggest-" + i;
    opt.setAttribute("aria-selected", String(i === highlight));
    opt.append(
      el("code", item.code),
      el("small", item.description + (item.hint ? " · " + item.hint : "")),
      el("em", item.kind),
    );
    opt.onmousedown = (e) => e.preventDefault();
    opt.onclick = () => complete(item);
    menu.append(opt);
  }
  menu.hidden = !menuItems.length;
  command.setAttribute("aria-expanded", String(!menu.hidden));
  if (menu.hidden) command.removeAttribute("aria-activedescendant");
  else {
    const id = "suggest-" + highlight;
    command.setAttribute("aria-activedescendant", id);
    $(id).scrollIntoView({ block: "nearest" });
  }
}
function updateMenu() {
  if (prompt || !command.value.trim()) {
    hideMenu();
    return;
  }
  menuItems = suggestions(command.value, activeProfile, $("mode").value).slice(0, 12);
  highlight = 0;
  paintMenu();
}
command.oninput = () => {
  $("command-error").textContent = "";
  updateMenu();
};
command.onfocus = () => {
  if (command.value && !command.value.endsWith(" ")) updateMenu();
};
command.onblur = hideMenu;
command.onkeydown = (e) => {
  if (!menu.hidden && ["ArrowDown", "ArrowUp", "Tab", "Escape"].includes(e.key)) {
    e.preventDefault();
    if (e.key === "Escape") hideMenu();
    else if (e.key === "Tab") complete(menuItems[highlight]);
    else {
      highlight = (highlight + (e.key === "ArrowUp" ? -1 : 1) + menuItems.length) % menuItems.length;
      paintMenu();
    }
  } else if (!prompt && (e.key === "ArrowUp" || e.key === "ArrowDown") && history.length) {
    e.preventDefault();
    historyIndex = Math.min(history.length, Math.max(0, historyIndex + (e.key === "ArrowUp" ? -1 : 1)));
    command.value = history[historyIndex] || "";
  }
};
$("mode").onchange = () => {
  command.value = "";
  hideMenu();
  $("command-error").textContent = "";
  render();
};
$("command-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const input = command.value.trim();
  hideMenu();
  if (!input) return;
  if (prompt) {
    if (session.answer(input.toLowerCase())) {
      command.value = "";
      $("command-error").textContent = "";
    } else $("command-error").textContent = "Reply with " + prompt.choices.join(" or ");
    return;
  }
  if (busy || state !== "live") return;
  busy = true;
  $("command-error").textContent = "";
  invalidate();
  try {
    const pending = session.submit(input, $("mode").value, $("target").value);
    command.value = "";
    history.push(input);
    if (history.length > 75) history.shift();
    historyIndex = history.length;
    await pending;
  } catch (error) {
    $("command-error").textContent = error.message;
  } finally {
    busy = false;
    invalidate();
  }
};
const splitter = $("splitter"),
  workspace = $("workspace");
function resize(value) {
  const n = Math.max(32, Math.min(65, Math.round(value)));
  workspace.style.setProperty("--split", n + "%");
  splitter.setAttribute("aria-valuenow", String(n));
}
splitter.onpointerdown = (e) => {
  splitter.setPointerCapture(e.pointerId);
  e.preventDefault();
};
splitter.onpointermove = (e) => {
  if (!splitter.hasPointerCapture(e.pointerId)) return;
  const rect = workspace.getBoundingClientRect();
  resize(((e.clientX - rect.left) / rect.width) * 100);
};
splitter.onkeydown = (e) => {
  if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
    e.preventDefault();
    resize(Number(splitter.getAttribute("aria-valuenow")) + (e.key === "ArrowLeft" ? -2 : 2));
  }
};
window.addEventListener("resize", invalidate);
window.addEventListener("pagehide", () => {
  if (state !== "closed") void session.stop().catch(() => {});
});
setInterval(() => {
  if (state !== "closed" && latestTime()) invalidate();
}, 1000);
profileChange();
render();
