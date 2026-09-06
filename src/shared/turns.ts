import type { ChatMessage } from "./types.js";

/**
 * A turn is the unit of the canvas graph: one user prompt plus the assistant
 * reply (and any tool calls) it produced.
 */
export interface Turn {
  /** User message that opens the turn. */
  messageId: string;
  sessionId: string;
  /** First line of the user text; "(empty prompt)" when the text is blank. */
  title: string;
  /** Assistant text of the turn's reply, "" when the agent only called tools. */
  preview: string;
  /** Distinct tool names across the whole turn, first-seen order. */
  toolNames: string[];
  /** Distinct models across the turn's assistant messages, first-seen order. */
  modelIds: string[];
  /** Creation time of the user message. */
  createdAt: number;
}

/**
 * Group a flat message chain into turns. A turn starts at every user message;
 * assistant messages append to the current turn's reply. Assistant messages
 * before the first user message belong to no turn and are dropped.
 */
export function buildTurns(sessionId: string, messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      const title =
        message.text
          .split("\n")
          .find((line) => line.trim())
          ?.trim() ?? "";
      current = {
        messageId: message.id,
        sessionId,
        title: title || "(empty prompt)",
        preview: "",
        toolNames: [...message.toolNames],
        modelIds: [],
        createdAt: message.createdAt,
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (message.text)
      current.preview = current.preview ? `${current.preview}\n${message.text}` : message.text;
    for (const name of message.toolNames) {
      if (!current.toolNames.includes(name)) current.toolNames.push(name);
    }
    if (message.modelId && !current.modelIds.includes(message.modelId)) {
      current.modelIds.push(message.modelId);
    }
  }

  return turns;
}
