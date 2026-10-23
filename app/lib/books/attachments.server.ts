/**
 * Receipts and bills kept with an entry. Stored in the database (images are
 * shrunk in the browser before upload). The file type is decided by the
 * file's own bytes, never by its name.
 *
 * Growzar (v1.1 V6): ported from Financify's Books (0cc8732) unchanged but
 * for the import. A file never leaves Books (D-72's spirit): not to Ask, not
 * to logs, not to any app; it goes with its entry when the book is purged.
 */

import { prisma } from "~/lib/db.server";
import { BooksError } from "./posting";
import type { BookView } from "./books.server";

/** The app sits behind a 1 MB request limit; leave room for the form around the file. */
export const MAX_ATTACHMENT_BYTES = 900 * 1024;
export const MAX_ATTACHMENTS = 10;

/** What the bytes are, if they're a kind we keep. */
export function sniffType(b: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | "application/pdf" | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  if (b.length >= 5 && String.fromCharCode(...b.slice(0, 5)) === "%PDF-") return "application/pdf";
  return null;
}

/** A safe file name for headers and lists. */
export function cleanFileName(name: string, type: string): string {
  const ext = type === "application/pdf" ? ".pdf" : type === "image/png" ? ".png" : type === "image/webp" ? ".webp" : ".jpg";
  const base = name.replace(/\.[^.]*$/, "").replace(/[^\p{L}\p{N} ._()-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "receipt";
  return base + ext;
}

export async function addAttachment(book: BookView, documentId: string, file: { name: string; bytes: Uint8Array }, actor: string | null) {
  if (file.bytes.length === 0) throw new BooksError("That file is empty", "file");
  if (file.bytes.length > MAX_ATTACHMENT_BYTES) throw new BooksError("That file is too large (900 KB at most). Photos are shrunk for you; for a PDF, save a smaller copy.", "file");
  const type = sniffType(file.bytes);
  if (!type) throw new BooksError("Attach a photo (JPEG, PNG, WebP) or a PDF", "file");
  return prisma.$transaction(async (tx) => {
    const doc = await tx.bkDocument.findFirst({ where: { id: documentId, bookId: book.id }, select: { id: true } });
    if (!doc) throw new BooksError("That entry doesn't exist");
    // Lock the entry so two uploads at once can't pass the limit together.
    await tx.$queryRaw`SELECT id FROM bk_documents WHERE id = ${doc.id} FOR UPDATE`;
    if ((await tx.bkAttachment.count({ where: { documentId: doc.id } })) >= MAX_ATTACHMENTS) throw new BooksError(`Up to ${MAX_ATTACHMENTS} files on an entry`, "file");
    const a = await tx.bkAttachment.create({
      data: { bookId: book.id, documentId: doc.id, fileName: cleanFileName(file.name, type), contentType: type, size: file.bytes.length, data: Buffer.from(file.bytes), createdBy: actor },
      select: { id: true, fileName: true, contentType: true, size: true, createdAt: true },
    });
    await tx.bkAuditEvent.create({ data: { bookId: book.id, actor, action: "document.attached", documentId: doc.id, detail: { attachmentId: a.id, fileName: a.fileName } } });
    return a;
  });
}

export async function listAttachments(book: BookView, documentId: string) {
  return prisma.bkAttachment.findMany({ where: { bookId: book.id, documentId }, select: { id: true, fileName: true, contentType: true, size: true, createdAt: true }, orderBy: { createdAt: "asc" } });
}

export async function getAttachment(book: BookView, id: string) {
  return prisma.bkAttachment.findFirst({ where: { id, bookId: book.id } });
}

export async function deleteAttachment(book: BookView, id: string, actor: string | null) {
  await prisma.$transaction(async (tx) => {
    const a = await tx.bkAttachment.findFirst({ where: { id, bookId: book.id }, select: { id: true, documentId: true, fileName: true } });
    if (!a) return;
    await tx.bkAttachment.delete({ where: { id: a.id } });
    await tx.bkAuditEvent.create({ data: { bookId: book.id, actor, action: "document.detached", documentId: a.documentId, detail: { fileName: a.fileName } } });
  });
}

/** Keep the receipts when an entry is corrected (copied to the replacement draft). */
export async function copyAttachments(book: BookView, fromDocumentId: string, toDocumentId: string) {
  const files = await prisma.bkAttachment.findMany({ where: { bookId: book.id, documentId: fromDocumentId } });
  if (files.length === 0) return;
  await prisma.bkAttachment.createMany({ data: files.map((f) => ({ bookId: book.id, documentId: toDocumentId, fileName: f.fileName, contentType: f.contentType, size: f.size, data: f.data, createdBy: f.createdBy })) });
}
