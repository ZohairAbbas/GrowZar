import { prisma } from "../db.server";
import { booksServerOn } from "./access";

/**
 * Books' two switches (D-91), with no auth imports, so the worker can read
 * them: the server's BOOKS_ENABLED and the organization's own.
 */
export const booksEnabled = () => booksServerOn(process.env.BOOKS_ENABLED);

/** Is Books on for this organization (server switch and the organization's own)? */
export async function booksOn(organizationId: string): Promise<boolean> {
  if (!booksEnabled()) return false;
  const s = await prisma.booksSettings.findUnique({ where: { organizationId }, select: { enabled: true } });
  return Boolean(s?.enabled);
}
