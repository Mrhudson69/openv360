import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireOwner } from "../auth.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { getSettings } from "../settings.js";

/** Max logo size: 2 MB. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

type LogoKind = { mime: string; ext: string };

/**
 * Detects an allowed logo image by magic bytes (png/jpeg/webp) or, for SVG, by a
 * leading `<` (optionally after a BOM / whitespace). Returns null if unrecognised.
 */
function detectLogo(buf: Buffer): LogoKind | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a)
    return { mime: "image/png", ext: "png" };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return { mime: "image/jpeg", ext: "jpg" };
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // "RIFF"
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // "WEBP"
  )
    return { mime: "image/webp", ext: "webp" };
  // SVG: skip a UTF-8 BOM and leading whitespace, then require a `<`.
  let i = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
  if (i < buf.length && buf[i] === 0x3c) return { mime: "image/svg+xml", ext: "svg" };
  return null;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** Removes any stored logo files (all known extensions) from the branding dir. */
async function removeLogoFiles(dataDir: string): Promise<void> {
  const dir = path.join(dataDir, "branding");
  await Promise.all(Object.keys(MIME_BY_EXT).map((ext) => fsp.rm(path.join(dir, `logo.${ext}`), { force: true })));
}

export async function brandingRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  const logoDir = path.join(config.dataDir, "branding");

  // Resolves the stored logo (if any) to an absolute path + mime, verifying the file exists.
  async function resolveLogo(): Promise<{ abs: string; mime: string } | null> {
    const { rows } = await db.query<{ brand_logo_path: string | null }>(
      "SELECT brand_logo_path FROM settings WHERE id = 1",
    );
    const rel = rows[0]?.brand_logo_path ?? null;
    if (!rel) return null;
    const abs = path.join(config.dataDir, rel);
    try {
      await fsp.access(abs);
    } catch {
      return null;
    }
    const ext = path.extname(rel).slice(1).toLowerCase();
    return { abs, mime: MIME_BY_EXT[ext] ?? "application/octet-stream" };
  }

  // Public: the login screen needs branding before authentication.
  app.get("/api/branding", async () => {
    const s = await getSettings(db);
    const logo = await resolveLogo();
    return {
      orgName: s.orgName,
      brandPrimary: s.brandPrimary,
      brandAccent: s.brandAccent,
      logoUrl: logo ? "/api/branding/logo" : null,
    };
  });

  // Public: stream the stored logo file.
  app.get("/api/branding/logo", async (_req, reply: FastifyReply) => {
    const logo = await resolveLogo();
    if (!logo) return reply.code(404).send({ error: "no logo set" });
    reply.header("content-type", logo.mime);
    reply.header("cache-control", "private, max-age=3600");
    return reply.send(fs.createReadStream(logo.abs));
  });

  // Upload / replace the logo (auth; multipart). The parent's global manager hook
  // already restricts non-GET requests to owners.
  app.post("/api/branding/logo", { preHandler: requireOwner(db) }, async (req, reply) => {
    let file: Buffer | undefined;
    try {
      for await (const part of req.parts({ limits: { fileSize: MAX_LOGO_BYTES, files: 1, fields: 10 } })) {
        if (part.type === "file") {
          if (part.fieldname !== "file") {
            part.file.resume();
            continue;
          }
          file = await part.toBuffer();
        }
      }
    } catch (err) {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE")
        return reply.code(413).send({ error: "logo exceeds 2 MB" });
      throw err;
    }
    if (!file || file.length === 0) return reply.code(400).send({ error: "missing file" });
    if (file.length > MAX_LOGO_BYTES) return reply.code(413).send({ error: "logo exceeds 2 MB" });
    const kind = detectLogo(file);
    if (!kind) return reply.code(415).send({ error: "file must be a PNG, JPEG, WEBP or SVG image" });

    await fsp.mkdir(logoDir, { recursive: true });
    // Replace any previous logo (possibly a different extension) before writing.
    await removeLogoFiles(config.dataDir);
    const rel = path.join("branding", `logo.${kind.ext}`);
    await fsp.writeFile(path.join(config.dataDir, rel), file);
    await db.query("UPDATE settings SET brand_logo_path = $1 WHERE id = 1", [rel]);
    return { logoUrl: "/api/branding/logo" };
  });

  // Remove the logo (auth).
  app.delete("/api/branding/logo", { preHandler: requireOwner(db) }, async () => {
    await removeLogoFiles(config.dataDir);
    await db.query("UPDATE settings SET brand_logo_path = NULL WHERE id = 1");
    return { ok: true };
  });
}
