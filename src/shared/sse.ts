/**
 * Minimal SSE parsing for opencode's /event stream.
 * Frames arrive as `data: {...}` lines separated by blank lines.
 */

export interface ServerEvent {
  type: string;
  properties: Record<string, unknown>;
}

/** Feed it every chunk; it buffers and yields complete frames. */
export function createSseParser(): (chunk: string) => ServerEvent[] {
  let buffer = "";

  return (chunk: string) => {
    buffer += chunk;
    const events: ServerEvent[] = [];
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseFrame(frame);
      if (event) events.push(event);
    }
    return events;
  };
}

function parseFrame(frame: string): ServerEvent | null {
  const dataLines = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join("\n")) as {
      type?: unknown;
      properties?: unknown;
    };
    if (typeof parsed.type !== "string") return null;
    const properties =
      parsed.properties && typeof parsed.properties === "object"
        ? (parsed.properties as Record<string, unknown>)
        : {};
    return { type: parsed.type, properties };
  } catch {
    return null;
  }
}
