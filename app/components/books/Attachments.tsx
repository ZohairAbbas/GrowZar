import { useState } from "react";
import { useNavigation, useSubmit } from "react-router";
import { Paperclip } from "lucide-react";

import { quietButtonClass } from "./BooksUi";

/**
 * Adding a receipt or bill to an entry (Books v1.1 V6), ported from
 * Financify's Attachments.tsx: a photo is shrunk in the browser to a JPEG
 * under the limit first; a PDF goes as it is. The server decides the type
 * from the file's own bytes.
 */
const LIMIT = 900 * 1024;

/** Shrink a photo to at most ~2000px and a JPEG under the limit. Other files are sent as they are. */
async function shrink(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    for (const [max, quality] of [
      [2000, 0.82],
      [1600, 0.72],
      [1200, 0.62],
    ] as const) {
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return file;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
      if (blob && blob.size <= LIMIT) return blob;
    }
  } catch {
    // The browser can't read it (some HEIC files): send as is and let the server decide.
  }
  return file;
}

export function kb(n: number) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function AttachFile() {
  const submit = useSubmit();
  const busy = useNavigation().state !== "idle";
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <label className={`${quietButtonClass} cursor-pointer`}>
        <Paperclip className="h-3.5 w-3.5" /> Add a photo or PDF
        <input
          type="file"
          accept="image/*,application/pdf"
          className="sr-only"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setProblem(null);
            const blob = await shrink(file);
            if (blob.size > LIMIT) {
              setProblem(`That file is ${kb(blob.size)}; files can be up to 900 KB. For a PDF, save a smaller copy.`);
              return;
            }
            const name = blob === file ? file.name : file.name.replace(/\.[^.]*$/, "") + ".jpg";
            const fd = new FormData();
            fd.set("intent", "attach");
            fd.set("file", new File([blob], name, { type: blob.type || file.type }));
            submit(fd, { method: "post", encType: "multipart/form-data" });
          }}
        />
      </label>
      {problem ? <p className="text-xs font-medium text-coral-700">{problem}</p> : null}
    </div>
  );
}
