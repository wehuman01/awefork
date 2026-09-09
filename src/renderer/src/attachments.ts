/**
 * Composer-side attachment staging: read pasted/dropped/picked files into
 * draft attachments — images verbatim, text-like files normalized to
 * text/plain, Word/RTF documents converted in the main process — then
 * flatten them into the prompt payload the IPC layer accepts.
 */
import { fileKind } from "../../shared/attachment-kinds";
import type { PromptAttachment } from "../../shared/types";

/** An image/file staged in a composer, not yet sent. */
export interface DraftAttachment {
  /** Local key for list rendering. */
  id: string;
  name: string;
  mime: string;
  dataUrl: string;
}

/** What staging did with a batch: what stuck, and why the rest didn't. */
export interface StageResult {
  staged: DraftAttachment[];
  /** Human-readable notes about skipped, converted or truncated files. */
  notes: string[];
}

/** Word/RTF → plain text, done in the main process (textutil). Injectable for tests. */
export type DocumentTextExtractor = (filename: string, bytes: Uint8Array) => Promise<string>;

const extractViaIpc: DocumentTextExtractor = (filename, bytes) =>
  window.awefork.convertDocument(filename, bytes);

/**
 * opencode inlines text/plain data URLs verbatim, so one runaway attachment
 * can eat the model's whole context window; cap each file here.
 */
export const MAX_TEXT_BYTES = 1_000_000;

let seq = 0;

function nextId(): string {
  return `att_${Date.now()}_${seq++}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // btoa needs one call per ~32K chars or the argument list overflows.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  // Back off to a code-point boundary so a multi-byte char isn't split.
  let end = maxBytes;
  while (end > 0) {
    const byte = bytes[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end--;
  }
  return `${new TextDecoder().decode(bytes.subarray(0, end))}\n\n[truncated after 1 MB]`;
}

export async function readAttachments(
  files: FileList | File[],
  extractDocumentText: DocumentTextExtractor = extractViaIpc,
): Promise<StageResult> {
  const staged: DraftAttachment[] = [];
  const notes: string[] = [];
  for (const file of [...files]) {
    const kind = fileKind(file);
    if (kind === "unsupported") {
      notes.push(`暂不支持 ${file.name || "该文件"} 的格式`);
      continue;
    }
    if (kind === "image") {
      staged.push({
        id: nextId(),
        name: file.name || "图片",
        mime: file.type,
        dataUrl: `data:${file.type};base64,${bytesToBase64(new Uint8Array(await file.arrayBuffer()))}`,
      });
      continue;
    }
    let text: string;
    if (kind === "document") {
      try {
        text = await extractDocumentText(file.name, new Uint8Array(await file.arrayBuffer()));
      } catch {
        notes.push(`无法从 ${file.name} 提取文本`);
        continue;
      }
      if (!text.trim()) {
        notes.push(`${file.name} 中没有可提取的文本`);
        continue;
      }
    } else {
      text = await file.text();
    }
    const clipped = truncateUtf8(text, MAX_TEXT_BYTES);
    if (clipped !== text) notes.push(`${file.name} 超过 1 MB，已截断`);
    staged.push({
      id: nextId(),
      name: file.name || "文档",
      // opencode only inlines text/plain data URLs; other text mimes would
      // ship to the model as opaque media blocks, so normalize here and let
      // the filename carry the real extension.
      mime: "text/plain",
      dataUrl: `data:text/plain;base64,${bytesToBase64(new TextEncoder().encode(clipped))}`,
    });
  }
  return { staged, notes };
}

/** Flatten staged attachments into the IPC prompt payload. */
export function toPromptAttachments(list: DraftAttachment[]): PromptAttachment[] {
  return list.map((a) => ({ mime: a.mime, filename: a.name, dataUrl: a.dataUrl }));
}
