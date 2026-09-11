import { describe, expect, it } from "vitest";
import {
  firstNumber,
  firstString,
  opencodeDescriptor,
  parseOpenCodeDescriptor,
  parseVersion,
  readPath,
  versionInRange,
} from "../src/shared/agent-descriptor";
import bundledJson from "../src/shared/agents/opencode.json";

/**
 * The descriptor is the place backend facts live now, so the vocabulary must
 * be closed: every test here pins a rejection the validator owes us, because
 * an unknown key that slips through is a silent behavior change at runtime —
 * the exact failure mode this layer exists to eliminate.
 */

/** Bundled descriptor as editable data, with overrides applied. */
function drifted(edit: (root: Record<string, unknown>) => void): unknown {
  const root = JSON.parse(JSON.stringify(bundledJson)) as Record<string, unknown>;
  edit(root);
  return root;
}

describe("bundled opencode descriptor", () => {
  it("parses and answers the facts the runtime reads", () => {
    const descriptor = opencodeDescriptor();
    expect(descriptor.kind).toBe("opencode");
    expect(descriptor.capabilities).toEqual({ deleteMessage: true, attachments: true });
    expect(descriptor.compat).toEqual({ min: "1.18.0", max: "1.19.0" });
    expect(descriptor.events.partSnapshot.kinds).toEqual({ text: "text", reasoning: "thinking" });
  });

  it("accepts a legitimate variation — the drift scenario this exists for", () => {
    const descriptor = parseOpenCodeDescriptor(
      drifted((root) => {
        (root.events as Record<string, unknown>).idle = ["session.done"];
        (root.endpoints as Record<string, unknown>).sessionMessages = "/session/{id}/messages/v2";
      }),
    );
    expect(descriptor.events.idle).toEqual(["session.done"]);
    expect(descriptor.endpoints.sessionMessages).toBe("/session/{id}/messages/v2");
  });
});

describe("vocabulary enforcement", () => {
  it("rejects an unknown top-level key, naming it", () => {
    expect(() => parseOpenCodeDescriptor(drifted((root) => (root.remote = true)))).toThrow(
      /unknown key\(s\) remote/,
    );
  });

  it("rejects an unknown key deep in a section", () => {
    expect(() =>
      parseOpenCodeDescriptor(
        drifted((root) => {
          const text = (root.messages as Record<string, unknown>).parts as Record<string, unknown>;
          (text.text as Record<string, unknown>).seperator = "\n";
        }),
      ),
    ).toThrow(/messages\.parts\.text: unknown key\(s\) seperator/);
  });

  it("rejects a wrong type", () => {
    expect(() =>
      parseOpenCodeDescriptor(
        drifted((root) => ((root.compat as Record<string, unknown>).min = 1.18)),
      ),
    ).toThrow(/compat\.min: expected a non-empty string/);
  });

  it("rejects a dot-path that walks into a prototype", () => {
    expect(() =>
      parseOpenCodeDescriptor(
        drifted((root) => {
          ((root.messages as Record<string, unknown>).fields as Record<string, unknown>).modelId = [
            "info.__proto__.modelID",
          ];
        }),
      ),
    ).toThrow(/bad path segment "__proto__"/);
  });

  it("rejects an empty candidate list", () => {
    expect(() =>
      parseOpenCodeDescriptor(
        drifted((root) => {
          ((root.sessions as Record<string, unknown>).fields as Record<string, unknown>).title = [];
        }),
      ),
    ).toThrow(/sessions\.fields\.title: expected a non-empty array/);
  });

  it("rejects a part-kind mapping to an unknown normalized kind", () => {
    expect(() =>
      parseOpenCodeDescriptor(
        drifted((root) => {
          const snapshot = (root.events as Record<string, unknown>).partSnapshot as Record<
            string,
            unknown
          >;
          (snapshot.kinds as Record<string, unknown>).reasoning = "musing";
        }),
      ),
    ).toThrow(/expected "text" or "thinking"/);
  });

  it("rejects an unknown fork cut strategy", () => {
    expect(() =>
      parseOpenCodeDescriptor(
        drifted((root) => ((root.fork as Record<string, unknown>).cut = "inclusive")),
      ),
    ).toThrow(/fork\.cut: unknown strategy/);
  });

  it("rejects the wrong backend kind", () => {
    expect(() => parseOpenCodeDescriptor(drifted((root) => (root.kind = "codex")))).toThrow(
      /expected "opencode"/,
    );
  });
});

describe("read helpers", () => {
  const row = {
    info: { id: "m1", modelID: "top", model: { modelID: "nested" }, variant: "" },
  };

  it("readPath walks dot-paths and stops at missing objects", () => {
    expect(readPath(row, "info.model.modelID")).toBe("nested");
    expect(readPath(row, "info.gone.modelID")).toBeUndefined();
    expect(readPath(null, "info")).toBeUndefined();
  });

  it("firstString takes the first non-empty candidate and skips blanks", () => {
    expect(firstString(row, ["info.modelID", "info.model.modelID"])).toBe("top");
    expect(firstString(row, ["info.variant", "info.model.modelID"])).toBe("nested");
    expect(firstString(row, ["info.nope"])).toBeNull();
  });

  it("firstNumber only accepts numbers", () => {
    expect(firstNumber({ c: "4", a: { b: 3 } }, ["c", "a.b"])).toBe(3);
    expect(firstNumber({ c: "4" }, ["c"])).toBeNull();
  });
});

describe("version probe helpers", () => {
  it("parses the first triple from CLI output", () => {
    expect(parseVersion("1.18.30")).toBe("1.18.30");
    expect(parseVersion("codex-cli 0.154.0\n")).toBe("0.154.0");
    expect(parseVersion("opencode 1.19.0 (abc+) extra 2.0")).toBe("1.19.0");
    expect(parseVersion("no digits here")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });

  it("treats compat as min-inclusive, max-exclusive", () => {
    const compat = { min: "1.18.0", max: "1.19.0" };
    expect(versionInRange("1.18.0", compat)).toBe(true);
    expect(versionInRange("1.18.30", compat)).toBe(true);
    expect(versionInRange("1.18", compat)).toBe(true); // missing patch counts as .0
    expect(versionInRange("1.17.9", compat)).toBe(false);
    expect(versionInRange("1.19.0", compat)).toBe(false);
    expect(versionInRange("2.0.0", compat)).toBe(false);
  });
});
