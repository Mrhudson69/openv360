import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { VERSION, type Config } from "../config.js";
import { serverUrl } from "./public.js";

/** OS the agent can run on. */
type Os = "linux" | "macos" | "windows";
/** CPU architectures the agent is published for. */
type Arch = "x86_64" | "aarch64";

const OSES: readonly Os[] = ["linux", "macos", "windows"];
const ARCHES: readonly Arch[] = ["x86_64", "aarch64"];
const SEMVER = /^\d+\.\d+\.\d+/;

/** One artifact in a release manifest. */
interface Artifact {
  file: string;
  sha256?: string | null;
}

/** Shape of `${downloadsDir}/releases.json`. */
interface Manifest {
  version: string;
  notes?: string;
  minSupported?: string;
  artifacts?: Record<string, Artifact>;
}

/** What the endpoint returns to the agent. */
export interface ReleaseResponse {
  version: string;
  notes: string;
  url: string | null;
  sha256: string | null;
  minSupported: string;
}

/**
 * Default artifact filenames per platform key, matching the names the installers
 * (install.sh / install.ps1) already download. Used when a manifest omits an
 * entry or when a release is synthesized from OPENV360_LATEST_VERSION.
 */
const DEFAULT_FILES: Record<string, string> = {
  "linux-x86_64": "openv360-agent_amd64.deb",
  "linux-aarch64": "openv360-agent_arm64.deb",
  "macos-universal": "openv360-agent_macos-universal.app.tar.gz",
  "windows-x86_64": "openv360-agent_x64-setup.exe",
};

/**
 * Candidate manifest keys for an (os, arch), most specific first. macOS ships a
 * single universal bundle, so arch-specific keys fall back to `macos-universal`.
 */
function keysFor(os: Os, arch: Arch): string[] {
  if (os === "macos") return ["macos-universal", `macos-${arch}`];
  if (os === "windows") return [`windows-${arch}`, "windows-x86_64"];
  return [`linux-${arch}`];
}

/**
 * Best-effort: resolve the latest published agent version from GitHub Releases,
 * derived from GITHUB_RELEASES_URL. Cached for an hour. This lets agents
 * auto-update after a new release with no admin action — the operator just runs
 * `openv360 update`; they do not have to set OPENV360_LATEST_VERSION by hand.
 * Returns null when no GitHub repo is configured or the lookup fails (the caller
 * then falls back to the server's own version, i.e. a no-op).
 */
const ghCache: { version: string | null; at: number } = { version: null, at: 0 };
const GH_TTL_MS = 15 * 60 * 1000;

function githubRepoSlug(url: string | undefined): string | null {
  if (!url) return null;
  const m = /github\.com\/([^/]+)\/([^/]+)/i.exec(url);
  return m ? `${m[1]}/${m[2].replace(/\.git$/, "")}` : null;
}

async function githubLatestVersion(config: Config): Promise<string | null> {
  const slug = githubRepoSlug(config.githubReleasesUrl ?? config.releaseBase);
  if (!slug) return null;
  if (ghCache.version && Date.now() - ghCache.at < GH_TTL_MS) return ghCache.version;
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "openv360-server" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`github ${res.status}`);
    const body = (await res.json()) as { tag_name?: string };
    const version = (body.tag_name ?? "").replace(/^v/, "").trim();
    ghCache.version = SEMVER.test(version) ? version : null;
    ghCache.at = Date.now();
    return ghCache.version;
  } catch {
    // Network blocked / rate-limited / air-gapped: cache the miss briefly so we
    // don't hammer the API, and fall back to OPENV360_LATEST_VERSION / no-op.
    ghCache.at = Date.now();
    return ghCache.version;
  }
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const raw = await fsp.readFile(path.join(dir, "releases.json"), "utf8");
    const m = JSON.parse(raw) as Manifest;
    if (m && typeof m.version === "string" && SEMVER.test(m.version)) return m;
  } catch {
    // no manifest, or it is unreadable / malformed
  }
  return null;
}

/**
 * Resolve the absolute download URL for an artifact file. Prefers an explicit
 * RELEASE_BASE, then the request-derived public base (`${base}/downloads`, which
 * itself redirects to GITHUB_RELEASES_URL when the file isn't on disk), then a
 * bare GITHUB_RELEASES_URL. Returns null when nothing can be determined.
 */
function resolveUrl(file: string, base: string | null, config: Config): string | null {
  const releaseBase = config.releaseBase ?? (base ? `${base}/downloads` : config.githubReleasesUrl ?? null);
  if (!releaseBase) return null;
  return `${releaseBase}/${encodeURIComponent(file)}`;
}

export async function releasesRoutes(app: FastifyInstance, { config }: { config: Config }) {
  app.get<{ Querystring: { os?: string; arch?: string } }>("/api/agent/release", async (req, reply) => {
    const os = (req.query.os ?? "") as Os;
    const arch = (req.query.arch ?? "x86_64") as Arch;
    if (!OSES.includes(os)) return reply.code(400).send({ error: "os must be one of linux, macos, windows" });
    if (!ARCHES.includes(arch)) return reply.code(400).send({ error: "arch must be one of x86_64, aarch64" });

    reply.header("cache-control", "no-store");
    const base = serverUrl(config, req);

    // 1) A manifest file on disk wins.
    let manifest = await readManifest(config.downloadsDir);
    // 2) Otherwise synthesize one from OPENV360_LATEST_VERSION, if set.
    if (!manifest && process.env.OPENV360_LATEST_VERSION && SEMVER.test(process.env.OPENV360_LATEST_VERSION)) {
      manifest = { version: process.env.OPENV360_LATEST_VERSION.trim() };
    }
    // 2b) Otherwise auto-detect the latest version from GitHub Releases, so a
    //     plain `openv360 update` propagates new agent builds with no config.
    if (!manifest) {
      const gh = await githubLatestVersion(config);
      if (gh) manifest = { version: gh };
    }

    // 3) Nothing configured: report the server's own version and no URL, so the
    //    agent simply no-ops (it only updates to a strictly newer version).
    if (!manifest) {
      const body: ReleaseResponse = { version: VERSION, notes: "", url: null, sha256: null, minSupported: "0.0.0" };
      return body;
    }

    const artifacts = manifest.artifacts ?? {};
    let artifact: Artifact | undefined;
    for (const key of keysFor(os, arch)) {
      if (artifacts[key]) {
        artifact = artifacts[key];
        break;
      }
    }
    // Fall back to the conventional filename for this platform when the manifest
    // has no explicit artifact entry (e.g. a synthesized manifest).
    const file = artifact?.file ?? DEFAULT_FILES[keysFor(os, arch)[0]!] ?? DEFAULT_FILES[keysFor(os, arch)[1] ?? ""];

    const body: ReleaseResponse = {
      version: manifest.version,
      notes: typeof manifest.notes === "string" ? manifest.notes : "",
      url: file ? resolveUrl(file, base, config) : null,
      sha256: artifact?.sha256 ?? null,
      minSupported: manifest.minSupported && SEMVER.test(manifest.minSupported) ? manifest.minSupported : "0.0.0",
    };
    return body;
  });
}
