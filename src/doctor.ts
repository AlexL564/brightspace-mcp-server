#!/usr/bin/env node
/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * `doctor` — a beginner-facing diagnostic. It runs a fixed, ordered list of
 * checks (Node version, saved setup, credential store, school reachability,
 * saved sign-in, one real API call, installed version) and prints one line
 * per check: a checkmark plus a short description, or a cross plus exactly
 * one plain-English next step.
 *
 * Every check after "setup found" depends on the ones before it, so a
 * missing config or a broken sign-in is reported once, with everything
 * downstream marked "skipped" instead of printing a cascade of confusing
 * errors for the same root cause.
 *
 * Like `setup` and `auth`, this never prints a secret: no password, token,
 * or cookie value appears in any line.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import {
  configStoreExists,
  loadConfigStore,
  type ConfigStoreData,
} from "./utils/config-store.js";
import { accountSessionDirectory, expandTilde } from "./utils/config.js";
import { getStoredPassword } from "./auth/credential-store.js";
import { discoverVersions } from "./api/version-discovery.js";
import { TokenManager } from "./auth/token-manager.js";
import type { TokenData } from "./types/index.js";
import { D2LApiClient } from "./api/client.js";
import { fetchAllItems } from "./api/paginate.js";
import {
  fetchLatestVersion,
  isNewerVersion,
  safeVersionLabel,
  installKindOf,
  type InstallKind,
} from "./utils/update-checker.js";
import {
  SETUP_COMMAND,
  AUTH_COMMAND,
  GLOBAL_INSTALL_COMMAND,
  CLEAR_NPX_CACHE_COMMAND,
} from "./utils/commands.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readInstalledVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── Types ─────────────────────────────────────────────────────────────

export type CheckId = "node" | "config" | "credential" | "network" | "session" | "courses" | "version";

export interface CheckResult {
  id: CheckId;
  ok: boolean;
  /** The full printable line, including its ✓/✗ prefix. */
  line: string;
}

export interface DoctorResult {
  checks: CheckResult[];
  allOk: boolean;
}

/**
 * Every external dependency doctor touches, as an injectable seam. Each
 * default below is the real implementation; tests override only the ones
 * relevant to the scenario under test, the same way
 * registerGetServerInfo injects readSignedInIdentity.
 */
export interface DoctorDeps {
  nodeVersion: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  configStoreExists: () => boolean;
  loadConfigStore: () => ConfigStoreData;
  getStoredPassword: (baseUrl: string, username: string) => Promise<string | null>;
  discoverVersions: (baseUrl: string) => Promise<unknown>;
  /** Reuses TokenManager — disk and, at most, one HTTP mint. Never a browser. */
  getSessionToken: (baseUrl: string, sessionDir: string) => Promise<TokenData | null>;
  /** One real course-list call, the same request get_my_courses makes. */
  countCourses: (baseUrl: string, sessionDir: string) => Promise<number>;
  fetchLatestVersion: () => Promise<string | null>;
  installKind: InstallKind;
  installedVersion: string;
}

function defaultDoctorDeps(): DoctorDeps {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    env: process.env,
    configStoreExists,
    loadConfigStore,
    getStoredPassword,
    discoverVersions,
    getSessionToken: (baseUrl, sessionDir) => new TokenManager({ baseUrl, sessionDir }).getToken(),
    countCourses: async (baseUrl, sessionDir) => {
      const apiClient = new D2LApiClient({
        baseUrl,
        tokenManager: new TokenManager({ baseUrl, sessionDir }),
      });
      const coursesPath = apiClient.lp("/enrollments/myenrollments/?orgUnitTypeId=3");
      const items = await fetchAllItems<unknown>(apiClient, coursesPath);
      return items.length;
    },
    fetchLatestVersion,
    installKind: installKindOf(),
    installedVersion: readInstalledVersion(),
  };
}

function pass(id: CheckId, message: string): CheckResult {
  return { id, ok: true, line: `✓ ${message}` };
}

function problem(id: CheckId, message: string): CheckResult {
  return { id, ok: false, line: `✗ ${message}` };
}

// ── Individual checks ────────────────────────────────────────────────

function checkNode(deps: DoctorDeps): CheckResult {
  const major = Number(deps.nodeVersion.replace(/^v/, "").split(".")[0]);
  if (Number.isFinite(major) && major >= 20) {
    return pass("node", `Node.js ${deps.nodeVersion} (20 or newer)`);
  }
  return problem(
    "node",
    `Node.js ${deps.nodeVersion} is too old — install Node 20 or newer from https://nodejs.org/, then try again.`
  );
}

interface ConfigCheckOk {
  ok: true;
  result: CheckResult;
  baseUrl: string;
  username: string;
  sessionDir: string;
}
interface ConfigCheckFail {
  ok: false;
  result: CheckResult;
}
type ConfigCheck = ConfigCheckOk | ConfigCheckFail;

/**
 * Checks the config FILE itself (not environment overrides) — this is the
 * thing a beginner's `setup` run produces, and "none of it is there yet" is
 * the single most common first-run state.
 */
function checkConfig(deps: DoctorDeps): ConfigCheck {
  let store: ConfigStoreData | null = null;
  try {
    if (deps.configStoreExists()) store = deps.loadConfigStore();
  } catch {
    store = null;
  }

  if (!store?.baseUrl || !store?.username) {
    return { ok: false, result: problem("config", `No setup found — run: ${SETUP_COMMAND}`) };
  }

  let baseUrl: string;
  try {
    baseUrl = new URL(store.baseUrl).origin;
  } catch {
    return { ok: false, result: problem("config", `The saved Brightspace URL is invalid — run: ${SETUP_COMMAND}`) };
  }

  const sessionRoot = deps.env.D2L_SESSION_DIR
    ? expandTilde(deps.env.D2L_SESSION_DIR)
    : store.sessionDir
      ? expandTilde(store.sessionDir)
      : path.join(os.homedir(), ".d2l-session");
  const sessionDir = accountSessionDirectory(sessionRoot, baseUrl, store.username);

  return {
    ok: true,
    result: pass("config", `Setup found — signed in as ${store.username} at ${baseUrl}`),
    baseUrl,
    username: store.username,
    sessionDir,
  };
}

async function checkCredential(deps: DoctorDeps, baseUrl: string, username: string): Promise<CheckResult> {
  try {
    const password = await deps.getStoredPassword(baseUrl, username);
    if (password) return pass("credential", "Password saved in your operating system's credential store");
    return problem("credential", `No saved password found for this account — run: ${SETUP_COMMAND}`);
  } catch (error) {
    // On Linux the store itself (secret-tool / an unlocked Secret Service)
    // is usually the problem, and the thrown error already explains that in
    // plain English. Elsewhere, re-running setup is the one fix that covers
    // every native-store failure a student could hit.
    if (deps.platform === "linux") {
      return problem("credential", error instanceof Error ? error.message : "The Linux credential store is locked or unavailable. Unlock your keyring and try again.");
    }
    return problem("credential", `Run setup again: ${SETUP_COMMAND}`);
  }
}

async function checkNetwork(deps: DoctorDeps, baseUrl: string): Promise<CheckResult> {
  try {
    await deps.discoverVersions(baseUrl);
    return pass("network", `${baseUrl} is reachable`);
  } catch {
    return problem(
      "network",
      `Could not reach ${baseUrl} — check your internet connection and the school address, then run doctor again.`
    );
  }
}

interface SessionCheckOk {
  ok: true;
  result: CheckResult;
}
interface SessionCheckFail {
  ok: false;
  result: CheckResult;
}

async function checkSession(deps: DoctorDeps, baseUrl: string, sessionDir: string): Promise<SessionCheckOk | SessionCheckFail> {
  const failMessage = `No working saved sign-in — open your AI app and ask a question to sign in, or run: ${AUTH_COMMAND}`;
  try {
    const token = await deps.getSessionToken(baseUrl, sessionDir);
    if (token) return { ok: true, result: pass("session", "Saved sign-in works — a token was issued without opening a browser") };
    return { ok: false, result: problem("session", failMessage) };
  } catch {
    return { ok: false, result: problem("session", failMessage) };
  }
}

async function checkCourses(deps: DoctorDeps, baseUrl: string, sessionDir: string): Promise<CheckResult> {
  try {
    const count = await deps.countCourses(baseUrl, sessionDir);
    return pass("courses", `Found ${count} course${count === 1 ? "" : "s"} on Brightspace`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "an unknown error";
    return problem("courses", `Could not load your courses (${detail}) — run doctor again after checking your connection.`);
  }
}

async function checkVersion(deps: DoctorDeps): Promise<CheckResult> {
  let latest: string | null = null;
  try {
    latest = await deps.fetchLatestVersion();
  } catch {
    latest = null;
  }

  const sourceNote = deps.installKind === "source-checkout" ? " (source checkout)" : "";

  // Offline, or the registry hiccuped: never treat "couldn't check" as a
  // failure — there is nothing actionable to tell a student here.
  if (latest === null) {
    return pass(
      "version",
      `Running v${safeVersionLabel(deps.installedVersion)}${sourceNote} — could not check for a newer version (you may be offline)`
    );
  }

  if (!isNewerVersion(latest, deps.installedVersion)) {
    return pass("version", `Running the latest version (v${safeVersionLabel(deps.installedVersion)})${sourceNote}`);
  }

  const from = safeVersionLabel(deps.installedVersion);
  const to = safeVersionLabel(latest);
  const nextStep =
    deps.installKind === "source-checkout"
      ? "pull the latest changes and run npm run build"
      : deps.installKind === "npm-install"
        ? `run: ${GLOBAL_INSTALL_COMMAND}`
        : `it updates automatically next time, or run: ${CLEAR_NPX_CACHE_COMMAND}`;
  return problem("version", `A newer version is available (v${from} to v${to}) — ${nextStep}.`);
}

// ── Orchestration ────────────────────────────────────────────────────

const SKIPPED_SETUP = `Skipped — finish setup first, then run doctor again: ${SETUP_COMMAND}`;
const SKIPPED_SESSION = "Skipped — fix the saved sign-in step above first, then run doctor again.";

function skip(id: CheckId, message: string): CheckResult {
  return problem(id, message);
}

export async function runDoctorChecks(overrides: Partial<DoctorDeps> = {}): Promise<DoctorResult> {
  const deps: DoctorDeps = { ...defaultDoctorDeps(), ...overrides };
  const checks: CheckResult[] = [];

  checks.push(checkNode(deps));

  const config = checkConfig(deps);
  checks.push(config.result);

  if (!config.ok) {
    checks.push(skip("credential", SKIPPED_SETUP));
    checks.push(skip("network", SKIPPED_SETUP));
    checks.push(skip("session", SKIPPED_SETUP));
    checks.push(skip("courses", SKIPPED_SETUP));
  } else {
    checks.push(await checkCredential(deps, config.baseUrl, config.username));
    checks.push(await checkNetwork(deps, config.baseUrl));

    const session = await checkSession(deps, config.baseUrl, config.sessionDir);
    checks.push(session.result);

    if (session.ok) {
      checks.push(await checkCourses(deps, config.baseUrl, config.sessionDir));
    } else {
      checks.push(skip("courses", SKIPPED_SESSION));
    }
  }

  checks.push(await checkVersion(deps));

  return { checks, allOk: checks.every((c) => c.ok) };
}

// ── CLI entry point ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const result = await runDoctorChecks();

  console.log("");
  console.log("Brightspace MCP Server — doctor");
  console.log("");
  for (const check of result.checks) console.log(`  ${check.line}`);
  console.log("");
  console.log(
    result.allOk
      ? "Everything looks good — open your AI app and ask a question."
      : "Fix the ✗ items above, then run doctor again."
  );
  console.log("");

  process.exitCode = result.allOk ? 0 : 1;
}

// VITEST is set only by the test runner, which imports this module for the
// functions above and must never run the real checks against this machine.
if (!process.env.VITEST) {
  main().catch((err) => {
    console.error("doctor failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
