import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Reversible secrets that the server must use (e.g. the SMTP password) are
// encrypted at rest with AES-256-GCM. The key comes from $OPENV360_SECRET /
// $SECRET_KEY if set, otherwise a random 32-byte key auto-generated once and
// stored at $DATA_DIR/secret.key (0600). Values are self-describing so legacy
// plaintext is still readable and gets re-encrypted on next write.
const PREFIX = "enc:v1:";
const dataDir = () => process.env.DATA_DIR || "./data";

let cached: Buffer | null = null;
function key(): Buffer {
  if (cached) return cached;
  const env = process.env.OPENV360_SECRET || process.env.SECRET_KEY;
  if (env) return (cached = crypto.createHash("sha256").update(env).digest());
  const p = path.join(dataDir(), "secret.key");
  try {
    const k = fs.readFileSync(p);
    if (k.length === 32) return (cached = k);
  } catch { /* generate below */ }
  fs.mkdirSync(dataDir(), { recursive: true });
  cached = crypto.randomBytes(32);
  fs.writeFileSync(p, cached, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
  return cached;
}

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + iv.toString("hex") + ":" + c.getAuthTag().toString("hex") + ":" + ct.toString("hex");
}

export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext
  try {
    const [, , ivH, tagH, ctH] = stored.split(":");
    const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivH!, "hex"));
    d.setAuthTag(Buffer.from(tagH!, "hex"));
    return Buffer.concat([d.update(Buffer.from(ctH!, "hex")), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}
