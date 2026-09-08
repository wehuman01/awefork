/**
 * Composer-side attachment staging: read pasted/dropped files into draft
 * attachments (images only for now), then flatten them into the prompt
 * payload the IPC layer accepts.
 */
import type { PromptAttachment } from "../../shared/types";

/** An image/file staged in a composer, not yet sent. */
export interface DraftAttachment {
  /** Local key for list rendering. */
  id: string;
  name: string;
  mime: string;
  dataUrl: string;
}

let seq = 0;

/** How many of the given files are attachable (images). */
export function countImages(files: FileList | File[]): number {
  return [...files].filter((f) => f.type.startsWith("image/")).length;
}

/** Read the image files into composer-staged attachments; non-images drop out. */
export function readAttachments(files: FileList | File[]): Promise<DraftAttachment[]> {
  return Promise.all(
    [...files]
      .filter((f) => f.type.startsWith("image/"))
      .map(
        (file) =>
          new Promise<DraftAttachment>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              resolve({
                id: `att_${Date.now()}_${seq++}`,
                name: file.name || "图片",
                mime: file.type,
                dataUrl: typeof reader.result === "string" ? reader.result : "",
              });
            };
            reader.readAsDataURL(file);
          }),
      ),
  );
}

/** Flatten staged attachments into the IPC prompt payload. */
export function toPromptAttachments(list: DraftAttachment[]): PromptAttachment[] {
  return list.map((a) => ({ mime: a.mime, filename: a.name, dataUrl: a.dataUrl }));
}
