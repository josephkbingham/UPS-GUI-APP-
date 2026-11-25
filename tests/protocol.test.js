import test from "node:test";
import assert from "node:assert/strict";
import { catalog, decode, FrameDecoder, parseCommand, suggestions } from "../app/protocol.js";
import { refreshSeconds } from "../app/session.js";

test("framing preserves chunks, noise, empty fields and adjacent acknowledgments", () => {
  const parser = new FrameDecoder();
  const result = ["boot\r\n^", "D0", "07,1", ",6", "00,^1^0"].flatMap((part) => parser.feed(part));
  assert.deepEqual(
    result.map((p) => [p.kind, p.wire]),
    [
      ["noise", "boot\r\n"],
      ["data", "^D007,1,600,"],
      ["ack", "^1"],
      ["nack", "^0"],
    ],
  );
  assert.equal(parser.buffer, "");
});

test("manual and raw command paths use the same profile and argument validation", () => {
  assert.equal(parseCommand("st3", "model", "frame").wire, "^P003ST3");
  assert.equal(parseCommand("SET PSD 30", "model", "frame").wire, "^S005PSD30");
  assert.equal(parseCommand("^S005PSD-1", "dual", "frame").wire, "^S005PSD-1");
  for (const line of [
    "SET PSD",
    "^S003PSD",
    "^S006PSD,30",
    "SET PSD 1000",
    "SET PSD 2.0",
    "POLL PSD 1",
    "ST3\rU",
  ])
    assert.throws(() => parseCommand(line, "model", "frame"));
  assert.throws(() => parseCommand("SET RWD 10", "dual", "frame"));
  assert.throws(() => parseCommand("XD2", "model", "frame"));
  assert.throws(() => parseCommand(":show", "dual", "text"));
  assert.equal(parseCommand(":show", "model", "text").wire, ":show\r");
  assert.equal(parseCommand("u", "dual", "text").wire, "u");
  assert.equal(suggestions("u", "model", "text")[0].code, "u");
  assert.ok(suggestions("ST", "dual", "frame").some((s) => s.code === "ST3"));
  assert.ok(catalog("model", "text").some((s) => s.code === ":set baud 2400"));
});

test("telemetry uses family-specific units, source codes and placeholders", () => {
  const normal = decode("ST3", "0,600,1,1151,32,330,62", "model");
  assert.deepEqual(
    [normal.source, normal.outputV, normal.outputA, normal.load],
    ["On utility", 115.1, 3.2, 62],
  );
  const u = decode("ST3", "2,599,1,1151,623,330,3", "upsilon");
  assert.deepEqual([u.source, u.outputHz, u.outputA, u.load], ["On bypass", 59.9, 3, 62.3]);
  assert.equal(decode("ST1", "0,2,0,0,32,843,501,12,26", "upsilon").charge, 84.3);
  assert.equal(decode("ST3", "5,0,1,0,0,0,0", "model").source, "Other / off / init");
  assert.equal(decode("ST3", ",0,1,0,0,0,0", "dual").source, "Unknown");
  assert.equal(decode("ST2", ",1,600,4400,,,600,4395", "dual").input2V, 439.5);
  assert.equal(decode("XD2", "66.21,0.35,0,66.38,0.22,0,40000,40200", "dual").string2V, 66.38);
  assert.deepEqual(decode("ST5", "0,1,0,0,,0,,1", "dual").alarms, [
    "Input bad / on battery",
    "Charger failure",
  ]);
  assert.deepEqual(decode("ST5", "0,0,1,0,0,0,,,,1,,,,,", "model").alarms, [
    "Inverter fault",
    "Cabinet fan failure",
  ]);
  assert.equal(decode("ST2", ",1,600,", "model").inputV, null);
  assert.throws(() => decode("ST2", ",1,600,nan", "model"));
  assert.throws(() => decode("ST3", "1,600", "model"));
});

test("refresh duration accepts positive whole seconds", () => {
  for (const v of ["", "0", "-1", "1.5", Infinity, "hello", 1e20]) assert.throws(() => refreshSeconds(v));
  assert.equal(refreshSeconds("5"), 5);
  assert.equal(refreshSeconds(1), 1);
});
