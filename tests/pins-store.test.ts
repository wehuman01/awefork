import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prunePin, readPins, togglePin, writePins } from "../src/shared/pins-store";

async function tempPinsPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "awefork-pins-")), "pins.json");
}

describe("pins store", () => {
  it("returns empty list when file does not exist", async () => {
    expect(await readPins(await tempPinsPath())).toEqual([]);
  });

  it("treats corrupted files as empty", async () => {
    const path = await tempPinsPath();
    await writeFile(path, "not json at all", "utf8");
    expect(await readPins(path)).toEqual([]);
  });

  it("togglePin adds then removes a session", async () => {
    const path = await tempPinsPath();
    await expect(togglePin(path, "ses_1")).resolves.toEqual(["ses_1"]);
    await expect(togglePin(path, "ses_2")).resolves.toEqual(["ses_1", "ses_2"]);
    await expect(togglePin(path, "ses_1")).resolves.toEqual(["ses_2"]);
    expect(await readPins(path)).toEqual(["ses_2"]);
  });

  it("prunePin drops only the given session", async () => {
    const path = await tempPinsPath();
    await writePins(path, ["ses_1", "ses_2"]);
    await expect(prunePin(path, "ses_1")).resolves.toEqual(["ses_2"]);
    expect(await readPins(path)).toEqual(["ses_2"]);
  });

  it("serializes concurrent toggles so neither pin is lost", async () => {
    const path = await tempPinsPath();
    // Fired without awaiting in between — without serialization both reads
    // see the empty file and the second write drops the first pin.
    await Promise.all([togglePin(path, "ses_1"), togglePin(path, "ses_2")]);
    expect(await readPins(path)).toEqual(["ses_1", "ses_2"]);
  });

  it("serializes a concurrent prune against a toggle", async () => {
    const path = await tempPinsPath();
    await writePins(path, ["ses_dead"]);
    await Promise.all([prunePin(path, "ses_dead"), togglePin(path, "ses_live")]);
    expect(await readPins(path)).toEqual(["ses_live"]);
  });
});

describe("cleanup", () => {
  it("removes temp dirs", async () => {
    const path = await tempPinsPath();
    await writePins(path, ["x"]);
    await rm(join(path, ".."), { recursive: true, force: true });
    expect(await readPins(path)).toEqual([]);
  });
});
