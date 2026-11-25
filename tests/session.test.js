import test from "node:test";
import assert from "node:assert/strict";
import { UpsSession } from "../app/session.js";
import { DemoLink } from "../app/demo.js";
import { frame } from "../app/protocol.js";

const settle = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
class Clock {
  time = 0;
  id = 0;
  timers = new Map();
  now = () => this.time;
  set = (fn, ms) => {
    const id = ++this.id;
    this.timers.set(id, { fn, at: this.time + ms });
    return id;
  };
  clear = (id) => this.timers.delete(id);
  async advance(ms) {
    const end = this.time + ms;
    await settle();
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
      await settle();
    }
    this.time = end;
    await settle();
  }
}
class Peer extends DemoLink {
  constructor(profile, clock) {
    super(profile);
    this.clock = clock;
    this.sent = [];
  }
  start(receive, lost) {
    this.receive = receive;
    this.lost = lost;
  }
  write(wire) {
    this.sent.push({ wire, at: this.clock.time });
    const reply = this.respond(wire);
    if (!reply || this.drop === wire) return;
    this.clock.set(() => {
      const data = new TextEncoder().encode(reply);
      this.receive(data.slice(0, 2));
      this.receive(data.slice(2));
    }, this.delay ?? 5);
  }
  async close() {
    this.closed = true;
  }
}
function setup(profile = "model", replyDelay = 5) {
  const clock = new Clock(),
    peer = new Peer(profile, clock),
    events = [];
  const session = new UpsSession(peer, {
    profile,
    clock,
    emit: (type, value) => events.push({ type, value }),
  });
  peer.delay = replyDelay;
  session.start();
  return { clock, peer, session, events };
}
const wires = (peer) => peer.sent.map((s) => s.wire);

test("wire cadence changes live, skips busy cycles and stops on disconnect", async () => {
  const { clock, peer, session } = setup();
  await clock.advance(4150);
  const times = () => peer.sent.filter((r) => r.wire === "^P003ST3").map((r) => r.at);
  assert.deepEqual(times(), [5, 2000, 4000]);
  session.setInterval(5);
  await clock.advance(10100);
  assert.deepEqual(times(), [5, 2000, 4000, 9150, 14150]);
  await session.stop();
  const count = peer.sent.length;
  await clock.advance(30000);
  assert.equal(peer.sent.length, count);
  const next = new UpsSession(peer, { clock, seconds: 5 });
  next.start();
  await clock.advance(5200);
  assert.equal(times().length, 7);
  await next.stop();
});

test("manual traffic takes the next free slot and does not cross outstanding polls", async () => {
  const { clock, peer, session } = setup();
  await clock.advance(7);
  const read = session.submit("MAN");
  await clock.advance(200);
  await read;
  assert.deepEqual(wires(peer).slice(0, 4), ["^P003AP1", "^P003ST3", "^P003MAN", "^P003ST1"]);
  assert.equal(session.state, "live");
  await session.stop();
});

test("slow polls do not build a backlog", async () => {
  const { clock, peer, session } = setup("model", 350);
  session.setInterval(1);
  await clock.advance(5200);
  const times = peer.sent.filter((s) => s.wire === "^P003ST3").map((s) => s.at);
  assert.deepEqual(times, [350, 4000]);
  await session.stop();
});

test("timeout leaves a write uncertain, drains a late ack and verifies before the next sample", async () => {
  const { clock, peer, session, events } = setup();
  await clock.advance(150);
  peer.drop = "^S005PSD30";
  const failure = assert.rejects(session.submit("SET PSD 30"), /outcome unknown/);
  await clock.advance(3000);
  await failure;
  peer.receive(new TextEncoder().encode("^1" + frame("D", "wrong")));
  await clock.advance(1200);
  assert.equal(wires(peer).filter((w) => w === "^S005PSD30").length, 1);
  assert.equal(wires(peer).filter((w) => w === "^P003AP1").length, 2);
  assert.equal(session.state, "live");
  assert.ok(events.some((e) => e.value?.detail === "Unsolicited data"));
  await session.stop();
});

test("dual text session routes one command, accepts a negative prompt and verifies return", async () => {
  const { clock, peer, session, events } = setup("dual");
  await clock.advance(200);
  const start = peer.sent.length;
  const job = session.submit("u", "text", "2");
  await clock.advance(4000);
  assert.ok(events.some((e) => e.type === "prompt" && e.value?.choices.includes("n")));
  assert.deepEqual(wires(peer).slice(start), ["^X", "2", "^X\r", "u"]);
  assert.equal(session.answer("n"), true);
  await clock.advance(250);
  await job;
  assert.deepEqual(wires(peer).slice(start, start + 8), [
    "^X",
    "2",
    "^X\r",
    "u",
    "n\r",
    "0",
    "^P003AP1",
    "^P003ST3",
  ]);
  assert.deepEqual(
    events.filter((e) => e.type === "router").map((e) => e.value),
    [true, false],
  );
  assert.equal(session.state, "live");
  await session.stop();
});

test("direct settings use carriage return and return to framed mode", async () => {
  const { clock, peer, session } = setup();
  await clock.advance(120);
  const job = session.submit(":show", "text");
  await clock.advance(800);
  await job;
  assert.ok(wires(peer).includes("show\r"));
  assert.equal(session.state, "live");
  await session.stop();
});

test("loss during router pass-through retains recovery and the next connection restores first", async () => {
  const { clock, peer, session, events } = setup("dual");
  await clock.advance(200);
  const job = assert.rejects(session.submit("u", "text", "1"));
  await clock.advance(100);
  peer.lost(Error("Unplugged"));
  await job;
  assert.equal(session.state, "closed");
  assert.deepEqual(
    events.filter((e) => e.type === "router").map((e) => e.value),
    [true],
  );
  const n = peer.sent.length;
  const next = new UpsSession(peer, { profile: "dual", clock });
  next.start({ recoverRouter: true });
  await clock.advance(200);
  assert.deepEqual(wires(peer).slice(n, n + 3), ["0", "^P003AP1", "^P003ST3"]);
  assert.equal(next.state, "live");
  await next.stop();
});

test("a malformed battery payload leaves its last sample intact and input polling continues", async () => {
  const { clock, peer, session, events } = setup();
  await clock.advance(150);
  const reply = peer.respond.bind(peer);
  peer.respond = (wire) => wire === "^P003ST1" ? frame("D", "bad field") : reply(wire);
  await clock.advance(2200);
  const samples = (key) => events.filter((e) => e.type === "sample" && e.value.key === key);
  assert.equal(samples("ST1").length, 1);
  assert.equal(samples("ST2").length, 2);
  assert.equal(session.state, "live");
  await session.stop();
});

test("an unanswered dual-board prompt cancels and exits the router exactly once", async () => {
  const { clock, peer, session } = setup("dual");
  await clock.advance(150);
  const action = session.submit("u", "text", "1");
  await clock.advance(30500);
  await action;
  assert.equal(wires(peer).filter((wire) => wire === "n\r").length, 1);
  assert.equal(wires(peer).filter((wire) => wire === "0").length, 1);
  assert.equal(peer.output, true);
  assert.equal(session.state, "live");
  await session.stop();
});
