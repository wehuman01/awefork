import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readComposer, writeComposer } from "../src/shared/composer-store";
import type { PersistedComposer } from "../src/shared/types";

async function tempComposerPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "awefork-composer-")), "composer.json");
}

const composer: PersistedComposer = {
  draft: {
    sessionId: "ses_1",
    atMessageId: "msg_3",
    text: "换个思路试试",
    model: { providerId: "glmp", modelId: "glm-5.3", variant: "high" },
    attachments: [
      { id: "att_1", name: "截图.png", mime: "image/png", dataUrl: "data:image/png;base64,xx" },
    ],
  },
  paneModels: { ses_2: { providerId: "glmp", modelId: "glm-5.3", variant: null } },
};

describe("composer store", () => {
  it("returns null when file does not exist", async () => {
    expect(await readComposer(await tempComposerPath())).toBeNull();
  });

  it("round-trips a draft with attachments and pane models", async () => {
    const path = await tempComposerPath();
    await writeComposer(path, composer);
    expect(await readComposer(path)).toEqual(composer);
  });

  it("round-trips an empty composer (no draft, no picks)", async () => {
    const path = await tempComposerPath();
    await writeComposer(path, { draft: null, paneModels: {} });
    expect(await readComposer(path)).toEqual({ draft: null, paneModels: {} });
  });

  it("treats corrupted files as empty", async () => {
    const path = await tempComposerPath();
    await writeFile(path, "not json at all", "utf8");
    expect(await readComposer(path)).toBeNull();
  });

  it("drops malformed fields instead of failing the whole read", async () => {
    const path = await tempComposerPath();
    await writeFile(
      path,
      JSON.stringify({
        draft: { sessionId: "ses_1", atMessageId: 7, text: "留存的文本", attachments: ["junk"] },
        paneModels: { ses_2: { providerId: "x" }, ses_3: { providerId: "y", modelId: "m" } },
      }),
      "utf8",
    );
    expect(await readComposer(path)).toEqual({
      draft: {
        sessionId: "ses_1",
        atMessageId: null,
        text: "留存的文本",
        model: null,
        attachments: [],
      },
      paneModels: { ses_3: { providerId: "y", modelId: "m", variant: null } },
    });
  });

  it("removes the file when written null", async () => {
    const path = await tempComposerPath();
    await writeComposer(path, composer);
    await writeComposer(path, null);
    expect(await readComposer(path)).toBeNull();
  });

  it("serializes concurrent writes so the last state wins cleanly", async () => {
    const path = await tempComposerPath();
    const emptied: PersistedComposer = { draft: null, paneModels: {} };
    // Without serialization both writes race the rename; the queue keeps
    // them ordered so the file never ends up mid-flight.
    await Promise.all([writeComposer(path, composer), writeComposer(path, emptied)]);
    expect(await readComposer(path)).toEqual(emptied);
  });
});

describe("cleanup", () => {
  it("removes temp dirs", async () => {
    const path = await tempComposerPath();
    await writeComposer(path, composer);
    await rm(join(path, ".."), { recursive: true, force: true });
    expect(await readComposer(path)).toBeNull();
  });
});
