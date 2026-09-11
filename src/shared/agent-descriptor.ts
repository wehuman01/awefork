/**
 * The agent descriptor vocabulary: every fact a backend version can change
 * without changing logic — endpoints, event names, field paths, the fork cut
 * translation, capabilities, the tested version range. The `agents/*.json`
 * files are that data; this module is the closed vocabulary they may use.
 *
 * parseOpenCodeDescriptor rejects unknown keys at every level, so a typo in a
 * descriptor fails loudly at startup instead of degrading silently at runtime
 * (the failure mode this layer exists to eliminate). The read helpers
 * (readPath/firstString/firstNumber) are the generic half of the interpreter:
 * adapters stay code only where there is real behavior.
 */
import opencodeJson from "./agents/opencode.json";

/** Version range the adapter was developed and tested against. Inclusive min, exclusive max. */
export interface AgentCompat {
  readonly min: string;
  readonly max: string;
}

/** Feature surface the renderer gates affordances on. */
export interface AgentCapabilities {
  readonly deleteMessage: boolean;
  readonly attachments: boolean;
}

/** REST paths; `{id}` / `{messageId}` are interpolated by the client. */
export interface AgentEndpoints {
  readonly sessions: string;
  readonly session: string;
  readonly sessionMessages: string;
  readonly sessionMessage: string;
  readonly sessionFork: string;
  readonly sessionAbort: string;
  readonly projects: string;
  readonly providers: string;
  readonly events: string;
}

/** Candidate dot-paths per normalized field, first hit wins. */
export interface AgentSessionFields {
  readonly id: readonly string[];
  readonly title: readonly string[];
  readonly directory: readonly string[];
  readonly parentSessionId: readonly string[];
  readonly createdAt: readonly string[];
  readonly updatedAt: readonly string[];
}

export interface AgentMessageFields {
  readonly id: readonly string[];
  readonly role: readonly string[];
  readonly modelId: readonly string[];
  readonly providerId: readonly string[];
  readonly variant: readonly string[];
  readonly createdAt: readonly string[];
  readonly completedAt: readonly string[];
  readonly finish: readonly string[];
  readonly outputTokens: readonly string[];
  readonly error: readonly string[];
}

/** A text-bearing part kind: which part type holds it and how rows join. */
export interface AgentTextPart {
  readonly type: string;
  readonly field: string;
  readonly join: string;
}

export interface AgentToolPart {
  readonly type: string;
  readonly nameField: string;
  readonly fallbackName: string;
}

export interface AgentFilePart {
  readonly type: string;
  readonly nameField: string;
  readonly fallbackName: string;
  readonly urlField: string;
  readonly mimeField: string;
}

export interface AgentMessageParts {
  readonly text: AgentTextPart;
  readonly thinking: AgentTextPart;
  readonly tool: AgentToolPart;
  readonly file: AgentFilePart;
}

export interface AgentErrorEvent {
  readonly name: string;
  readonly detailPaths: readonly string[];
}

export interface AgentStatusEvent {
  readonly name: string;
  /** Dot-path to the status discriminator inside the frame's properties. */
  readonly valuePath: string;
  readonly busyValue: string;
  readonly idleValue: string;
}

export interface AgentPartSnapshotEvent {
  readonly name: string;
  /** Property key holding the whole part object. */
  readonly partField: string;
  /** Older builds carry the text delta in the snapshot frame itself. */
  readonly deltaField: string;
  /** Backend part type → normalized stream kind. */
  readonly kinds: Readonly<Record<string, "text" | "thinking">>;
}

export interface AgentPartDeltaEvent {
  readonly name: string;
  /** Only deltas for this field value are forwarded. */
  readonly field: string;
  readonly textFieldValue: string;
  readonly partIdField: string;
  readonly deltaField: string;
}

/**
 * Per-turn file-change recording facts: which tools touch files, where the
 * state discriminator and the file path live inside a tool part, and which
 * state values mean the tool finished. Optional — a descriptor without this
 * section runs with recording off.
 */
export interface AgentFileChangesFact {
  readonly tools: readonly string[];
  readonly stateKeyPath: string;
  readonly filePathPaths: readonly string[];
  readonly doneStates: readonly string[];
}

export interface AgentEvents {
  /** Frame names that mean "re-read this session". */
  readonly refresh: readonly string[];
  /** Frames that carry nothing awefork needs (message.updated replays on fork). */
  readonly ignore: readonly string[];
  readonly idle: readonly string[];
  readonly error: AgentErrorEvent;
  readonly status: AgentStatusEvent;
  readonly partSnapshot: AgentPartSnapshotEvent;
  readonly partDelta: AgentPartDeltaEvent;
  readonly sessionIdPaths: readonly string[];
  readonly messageIdPaths: readonly string[];
}

export interface OpenCodeDescriptor {
  readonly kind: "opencode";
  readonly compat: AgentCompat;
  readonly capabilities: AgentCapabilities;
  /**
   * How the backend's fork primitive takes a cut point. opencode's cut is
   * exclusive (the branch keeps messages strictly before it), so the adapter
   * passes the NEXT user message after the fork anchor — "next-user-exclusive".
   */
  readonly fork: { readonly cut: "next-user-exclusive" };
  /** Present = the adapter records per-turn file changes from tool parts. */
  readonly fileChanges?: AgentFileChangesFact;
  readonly endpoints: AgentEndpoints;
  readonly sessions: { readonly fields: AgentSessionFields };
  readonly messages: { readonly fields: AgentMessageFields; readonly parts: AgentMessageParts };
  readonly events: AgentEvents;
}

export class DescriptorSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DescriptorSchemaError";
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function objectAt(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DescriptorSchemaError(`${where}: expected an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  const unknownKeys = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknownKeys.length > 0) {
    throw new DescriptorSchemaError(`${where}: unknown key(s) ${unknownKeys.join(", ")}`);
  }
}

function stringAt(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") {
    throw new DescriptorSchemaError(`${where}: expected a non-empty string`);
  }
  return value;
}

function booleanAt(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") {
    throw new DescriptorSchemaError(`${where}: expected a boolean`);
  }
  return value;
}

function stringsAt(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DescriptorSchemaError(`${where}: expected a non-empty array of strings`);
  }
  return value.map((entry, index) => stringAt(entry, `${where}[${index}]`));
}

/** A dot-path segment must never walk off plain data into an object's prototype chain. */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function dotPathsAt(value: unknown, where: string): string[] {
  return stringsAt(value, where).map((path, index) => {
    for (const segment of path.split(".")) {
      if (segment === "" || FORBIDDEN_SEGMENTS.has(segment)) {
        throw new DescriptorSchemaError(`${where}[${index}]: bad path segment "${segment}"`);
      }
    }
    return path;
  });
}

function section(value: unknown, key: string, where: string): Record<string, unknown> {
  const record = objectAt(value, where);
  if (!(key in record)) throw new DescriptorSchemaError(`${where}: missing "${key}"`);
  return objectAt(record[key], `${where}.${key}`);
}

function parseFieldPaths<T extends object>(
  value: unknown,
  keys: readonly (keyof T & string)[],
  where: string,
): T {
  const record = objectAt(value, where);
  onlyKeys(record, keys, where);
  return Object.fromEntries(
    keys.map((key) => [key, dotPathsAt(record[key], `${where}.${key}`)]),
  ) as unknown as T;
}

function parseTextPart(value: unknown, where: string): AgentTextPart {
  const record = objectAt(value, where);
  onlyKeys(record, ["type", "field", "join"], where);
  return {
    type: stringAt(record.type, `${where}.type`),
    field: stringAt(record.field, `${where}.field`),
    join: stringAt(record.join, `${where}.join`),
  };
}

export function parseOpenCodeDescriptor(value: unknown): OpenCodeDescriptor {
  const root = objectAt(value, "agent descriptor");
  onlyKeys(
    root,
    [
      "kind",
      "compat",
      "capabilities",
      "fork",
      "fileChanges",
      "endpoints",
      "sessions",
      "messages",
      "events",
    ],
    "agent descriptor",
  );
  if (root.kind !== "opencode") {
    throw new DescriptorSchemaError(`agent descriptor.kind: expected "opencode"`);
  }

  const compat = section(root, "compat", "agent descriptor");
  onlyKeys(compat, ["min", "max"], "compat");
  const parsedCompat = {
    min: stringAt(compat.min, "compat.min"),
    max: stringAt(compat.max, "compat.max"),
  };

  const capabilities = section(root, "capabilities", "agent descriptor");
  onlyKeys(capabilities, ["deleteMessage", "attachments"], "capabilities");
  const parsedCapabilities = {
    deleteMessage: booleanAt(capabilities.deleteMessage, "capabilities.deleteMessage"),
    attachments: booleanAt(capabilities.attachments, "capabilities.attachments"),
  };

  const fork = section(root, "fork", "agent descriptor");
  onlyKeys(fork, ["cut"], "fork");
  if (fork.cut !== "next-user-exclusive") {
    throw new DescriptorSchemaError(`fork.cut: unknown strategy "${String(fork.cut)}"`);
  }

  // Optional section: present = file-change recording is on for this backend.
  let fileChanges: AgentFileChangesFact | undefined;
  if (root.fileChanges !== undefined) {
    const changes = objectAt(root.fileChanges, "fileChanges");
    onlyKeys(changes, ["tools", "stateKeyPath", "filePathPaths", "doneStates"], "fileChanges");
    const stateKeyPath = stringAt(changes.stateKeyPath, "fileChanges.stateKeyPath");
    for (const segment of stateKeyPath.split(".")) {
      if (segment === "" || FORBIDDEN_SEGMENTS.has(segment)) {
        throw new DescriptorSchemaError(`fileChanges.stateKeyPath: bad path segment "${segment}"`);
      }
    }
    fileChanges = {
      tools: stringsAt(changes.tools, "fileChanges.tools"),
      stateKeyPath,
      filePathPaths: dotPathsAt(changes.filePathPaths, "fileChanges.filePathPaths"),
      doneStates: stringsAt(changes.doneStates, "fileChanges.doneStates"),
    };
  }

  const endpoints = section(root, "endpoints", "agent descriptor");
  const endpointKeys = [
    "sessions",
    "session",
    "sessionMessages",
    "sessionMessage",
    "sessionFork",
    "sessionAbort",
    "projects",
    "providers",
    "events",
  ] as const;
  onlyKeys(endpoints, endpointKeys, "endpoints");
  const parsedEndpoints = Object.fromEntries(
    endpointKeys.map((key) => [key, stringAt(endpoints[key], `endpoints.${key}`)]),
  ) as unknown as AgentEndpoints;

  const sessions = section(root, "sessions", "agent descriptor");
  const sessionsFields = parseFieldPaths<AgentSessionFields>(
    sessions.fields,
    ["id", "title", "directory", "parentSessionId", "createdAt", "updatedAt"],
    "sessions.fields",
  );

  const messages = section(root, "messages", "agent descriptor");
  const messagesFields = parseFieldPaths<AgentMessageFields>(
    messages.fields,
    [
      "id",
      "role",
      "modelId",
      "providerId",
      "variant",
      "createdAt",
      "completedAt",
      "finish",
      "outputTokens",
      "error",
    ],
    "messages.fields",
  );

  const parts = objectAt(messages.parts, "messages.parts");
  onlyKeys(parts, ["text", "thinking", "tool", "file"], "messages.parts");
  const tool = section(parts, "tool", "messages.parts");
  onlyKeys(tool, ["type", "nameField", "fallbackName"], "messages.parts.tool");
  const file = section(parts, "file", "messages.parts");
  onlyKeys(
    file,
    ["type", "nameField", "fallbackName", "urlField", "mimeField"],
    "messages.parts.file",
  );

  const events = section(root, "events", "agent descriptor");
  onlyKeys(
    events,
    [
      "refresh",
      "ignore",
      "idle",
      "error",
      "status",
      "partSnapshot",
      "partDelta",
      "sessionIdPaths",
      "messageIdPaths",
    ],
    "events",
  );

  const errorEvent = section(events, "error", "events");
  onlyKeys(errorEvent, ["name", "detailPaths"], "events.error");
  const status = section(events, "status", "events");
  onlyKeys(status, ["name", "valuePath", "busyValue", "idleValue"], "events.status");
  const partSnapshot = section(events, "partSnapshot", "events");
  onlyKeys(partSnapshot, ["name", "partField", "deltaField", "kinds"], "events.partSnapshot");
  const kindsRecord = objectAt(partSnapshot.kinds, "events.partSnapshot.kinds");
  for (const [partType, kind] of Object.entries(kindsRecord)) {
    if (kind !== "text" && kind !== "thinking") {
      throw new DescriptorSchemaError(
        `events.partSnapshot.kinds.${partType}: expected "text" or "thinking", got ${describe(kind)}`,
      );
    }
  }
  const partDelta = section(events, "partDelta", "events");
  onlyKeys(
    partDelta,
    ["name", "field", "textFieldValue", "partIdField", "deltaField"],
    "events.partDelta",
  );

  return {
    kind: "opencode",
    compat: parsedCompat,
    capabilities: parsedCapabilities,
    fork: { cut: "next-user-exclusive" },
    ...(fileChanges ? { fileChanges } : {}),
    endpoints: parsedEndpoints,
    sessions: { fields: sessionsFields },
    messages: {
      fields: messagesFields,
      parts: {
        text: parseTextPart(parts.text, "messages.parts.text"),
        thinking: parseTextPart(parts.thinking, "messages.parts.thinking"),
        tool: {
          type: stringAt(tool.type, "messages.parts.tool.type"),
          nameField: stringAt(tool.nameField, "messages.parts.tool.nameField"),
          fallbackName: stringAt(tool.fallbackName, "messages.parts.tool.fallbackName"),
        },
        file: {
          type: stringAt(file.type, "messages.parts.file.type"),
          nameField: stringAt(file.nameField, "messages.parts.file.nameField"),
          fallbackName: stringAt(file.fallbackName, "messages.parts.file.fallbackName"),
          urlField: stringAt(file.urlField, "messages.parts.file.urlField"),
          mimeField: stringAt(file.mimeField, "messages.parts.file.mimeField"),
        },
      },
    },
    events: {
      refresh: stringsAt(events.refresh, "events.refresh"),
      ignore: stringsAt(events.ignore, "events.ignore"),
      idle: stringsAt(events.idle, "events.idle"),
      error: {
        name: stringAt(errorEvent.name, "events.error.name"),
        detailPaths: dotPathsAt(errorEvent.detailPaths, "events.error.detailPaths"),
      },
      status: {
        name: stringAt(status.name, "events.status.name"),
        valuePath: stringAt(status.valuePath, "events.status.valuePath"),
        busyValue: stringAt(status.busyValue, "events.status.busyValue"),
        idleValue: stringAt(status.idleValue, "events.status.idleValue"),
      },
      partSnapshot: {
        name: stringAt(partSnapshot.name, "events.partSnapshot.name"),
        partField: stringAt(partSnapshot.partField, "events.partSnapshot.partField"),
        deltaField: stringAt(partSnapshot.deltaField, "events.partSnapshot.deltaField"),
        kinds: kindsRecord as Record<string, "text" | "thinking">,
      },
      partDelta: {
        name: stringAt(partDelta.name, "events.partDelta.name"),
        field: stringAt(partDelta.field, "events.partDelta.field"),
        textFieldValue: stringAt(partDelta.textFieldValue, "events.partDelta.textFieldValue"),
        partIdField: stringAt(partDelta.partIdField, "events.partDelta.partIdField"),
        deltaField: stringAt(partDelta.deltaField, "events.partDelta.deltaField"),
      },
      sessionIdPaths: dotPathsAt(events.sessionIdPaths, "events.sessionIdPaths"),
      messageIdPaths: dotPathsAt(events.messageIdPaths, "events.messageIdPaths"),
    },
  };
}

let cached: OpenCodeDescriptor | null = null;

/** The bundled opencode descriptor, validated once per process. */
export function opencodeDescriptor(): OpenCodeDescriptor {
  cached ??= parseOpenCodeDescriptor(opencodeJson);
  return cached;
}

// ---------------------------------------------------------------------------
// Generic read helpers: the interpretation half of the data/code split. They
// take `unknown` on purpose — tolerance for shape drift is the whole point.

/** Walk one dot-path ("info.model.modelID"); undefined as soon as it leaves the data. */
export function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** First dot-path whose value is a non-empty string, null when none is. */
export function firstString(source: unknown, candidates: readonly string[]): string | null {
  for (const path of candidates) {
    const value = readPath(source, path);
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/** First dot-path whose value is a number, null when none is. */
export function firstNumber(source: unknown, candidates: readonly string[]): number | null {
  for (const path of candidates) {
    const value = readPath(source, path);
    if (typeof value === "number") return value;
  }
  return null;
}

/** First x.y[.z…] triple in raw CLI output, null when there is none. */
export function parseVersion(raw: string): string | null {
  return raw.match(/\d+\.\d+(?:\.\d+)*/)?.[0] ?? null;
}

/** min inclusive, max exclusive; missing patch segments count as .0. */
export function versionInRange(version: string, compat: AgentCompat): boolean {
  const triple = (value: string): [number, number, number] => {
    const parts = value.split(".").map((segment) => Number.parseInt(segment, 10) || 0);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const compare = (a: readonly number[], b: readonly number[]): number => {
    for (let i = 0; i < 3; i += 1) {
      if (a[i] !== b[i]) return (a[i] ?? 0) < (b[i] ?? 0) ? -1 : 1;
    }
    return 0;
  };
  const actual = triple(version);
  return compare(actual, triple(compat.min)) >= 0 && compare(actual, triple(compat.max)) < 0;
}
