import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  dataDir: string;
  dashboardDir: string;
  corsOrigin: string | undefined;
  migrationsDir: string;
  installerDir: string;
  downloadsDir: string;
  publicUrl: string | undefined;
  releaseBase: string | undefined;
  githubReleasesUrl: string | undefined;
}

const trimSlash = (v: string | undefined) => (v ? v.trim().replace(/\/+$/, "") || undefined : undefined);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.DATA_DIR ?? "./data");
  return {
    databaseUrl: env.DATABASE_URL ?? "postgres://openv360:openv360@localhost:5432/openv360",
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    dataDir,
    dashboardDir: path.resolve(env.DASHBOARD_DIR ?? path.join(here, "../../dashboard/dist")),
    corsOrigin: env.CORS_ORIGIN || undefined,
    migrationsDir: path.resolve(env.MIGRATIONS_DIR ?? path.join(here, "../migrations")),
    installerDir: path.resolve(env.INSTALLER_DIR ?? path.join(here, "../../installer")),
    downloadsDir: path.resolve(env.DOWNLOADS_DIR ?? path.join(dataDir, "downloads")),
    publicUrl: trimSlash(env.PUBLIC_URL),
    releaseBase: trimSlash(env.RELEASE_BASE),
    githubReleasesUrl: trimSlash(env.GITHUB_RELEASES_URL),
  };
}

export const VERSION = "0.1.5";
