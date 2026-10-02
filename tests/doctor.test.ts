import { describe, it, expect } from "vitest";
import { runDoctorChecks, type DoctorDeps } from "../src/doctor.js";
import { SETUP_COMMAND, AUTH_COMMAND, GLOBAL_INSTALL_COMMAND, CLEAR_NPX_CACHE_COMMAND } from "../src/utils/commands.js";

/**
 * doctor is a beginner-facing diagnostic: one line per check, a plain-English
 * next step on every ✗, and checks downstream of a failure are reported as
 * skipped rather than cascading into confusing errors. Every external
 * dependency is injected (the same seam get_server_info uses for
 * readSignedInIdentity), so these tests never touch the filesystem, the
 * native credential store, or the network.
 */

const STORE = { baseUrl: "https://purdue.brightspace.com", username: "student42" };

function deps(overrides: Partial<DoctorDeps> = {}): Partial<DoctorDeps> {
  return {
    nodeVersion: "v20.11.0",
    platform: "darwin",
    env: {},
    configStoreExists: () => true,
    loadConfigStore: () => ({ ...STORE }),
    getStoredPassword: async () => "a-password",
    discoverVersions: async () => ({ lp: "1.50", le: "1.90" }),
    getSessionToken: async () => ({ accessToken: "tok", capturedAt: 0, expiresAt: 0, source: "cache" as const }),
    countCourses: async () => 4,
    fetchLatestVersion: async () => "3.9.9",
    installKind: "npx-cache",
    installedVersion: "3.9.9",
    ...overrides,
  };
}

const idOf = (result: Awaited<ReturnType<typeof runDoctorChecks>>, id: string) =>
  result.checks.find((c) => c.id === id)!;

describe("doctor: all-pass path", () => {
  it("passes every check and reports a clean exit", async () => {
    const result = await runDoctorChecks(deps());
    expect(result.allOk).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.checks.map((c) => c.id)).toEqual([
      "node", "config", "credential", "network", "session", "courses", "version",
    ]);
  });

  it("reports the course count from the real call", async () => {
    const result = await runDoctorChecks(deps({ countCourses: async () => 7 }));
    expect(idOf(result, "courses").line).toBe("✓ Found 7 courses on Brightspace");
  });

  it("uses singular 'course' for exactly one", async () => {
    const result = await runDoctorChecks(deps({ countCourses: async () => 1 }));
    expect(idOf(result, "courses").line).toBe("✓ Found 1 course on Brightspace");
  });

  it("reports the config line with the account and school", async () => {
    const result = await runDoctorChecks(deps());
    expect(idOf(result, "config").line).toBe("✓ Setup found — signed in as student42 at https://purdue.brightspace.com");
  });
});

describe("doctor: (a) Node version", () => {
  it("fails on Node below 20 with an install link", async () => {
    const result = await runDoctorChecks(deps({ nodeVersion: "v18.19.0" }));
    const check = idOf(result, "node");
    expect(check.ok).toBe(false);
    expect(check.line).toContain("v18.19.0");
    expect(check.line).toContain("too old");
    expect(check.line).toContain("https://nodejs.org/");
    expect(result.allOk).toBe(false);
  });

  it("passes on exactly Node 20", async () => {
    const result = await runDoctorChecks(deps({ nodeVersion: "v20.0.0" }));
    expect(idOf(result, "node").ok).toBe(true);
  });
});

describe("doctor: (b) config file", () => {
  it("fails with 'run setup' when no config file exists", async () => {
    const result = await runDoctorChecks(deps({ configStoreExists: () => false }));
    const check = idOf(result, "config");
    expect(check.ok).toBe(false);
    expect(check.line).toContain(SETUP_COMMAND);
  });

  it("fails when the config file has no username", async () => {
    const result = await runDoctorChecks(
      deps({ loadConfigStore: () => ({ baseUrl: "https://purdue.brightspace.com" }) })
    );
    expect(idOf(result, "config").ok).toBe(false);
  });

  it("fails when the config file has no baseUrl", async () => {
    const result = await runDoctorChecks(deps({ loadConfigStore: () => ({ username: "student42" }) }));
    expect(idOf(result, "config").ok).toBe(false);
  });

  it("fails when the config file cannot be parsed", async () => {
    const result = await runDoctorChecks(
      deps({
        loadConfigStore: () => {
          throw new Error("Unexpected token");
        },
      })
    );
    expect(idOf(result, "config").ok).toBe(false);
    expect(idOf(result, "config").line).toContain(SETUP_COMMAND);
  });

  it("skips every downstream check with a clear reason when config fails", async () => {
    const result = await runDoctorChecks(deps({ configStoreExists: () => false }));
    for (const id of ["credential", "network", "session", "courses"]) {
      const check = idOf(result, id);
      expect(check.ok).toBe(false);
      expect(check.line).toContain("Skipped");
    }
    // version is independent of setup and still runs
    expect(idOf(result, "version").ok).toBe(true);
  });
});

describe("doctor: (c) credential store", () => {
  it("fails with 'run setup' when no password is saved", async () => {
    const result = await runDoctorChecks(deps({ getStoredPassword: async () => null }));
    const check = idOf(result, "credential");
    expect(check.ok).toBe(false);
    expect(check.line).toContain(SETUP_COMMAND);
  });

  it("explains the unlocked keyring on Linux when the store throws", async () => {
    const result = await runDoctorChecks(
      deps({
        platform: "linux",
        getStoredPassword: async () => {
          throw new Error("Linux requires secret-tool and an unlocked Secret Service. Install libsecret-tools (Debian/Ubuntu) or your distribution's libsecret tools, unlock the desktop keyring, then retry.");
        },
      })
    );
    const check = idOf(result, "credential");
    expect(check.ok).toBe(false);
    expect(check.line).toContain("secret-tool");
    expect(check.line).toContain("keyring");
  });

  it("says 'run setup again' on a non-Linux store failure", async () => {
    const result = await runDoctorChecks(
      deps({
        platform: "darwin",
        getStoredPassword: async () => {
          throw new Error("The native credential store is locked or unavailable.");
        },
      })
    );
    const check = idOf(result, "credential");
    expect(check.ok).toBe(false);
    expect(check.line).toContain(SETUP_COMMAND);
    expect(check.line).not.toContain("secret-tool");
  });
});

describe("doctor: (d) school URL reachability", () => {
  it("fails with a plain next step when the API does not answer", async () => {
    const result = await runDoctorChecks(
      deps({
        discoverVersions: async () => {
          throw new Error("ECONNREFUSED");
        },
      })
    );
    const check = idOf(result, "network");
    expect(check.ok).toBe(false);
    expect(check.line).toContain("https://purdue.brightspace.com");
    expect(check.line).toContain("internet connection");
  });
});

describe("doctor: (e) saved session / token without a browser", () => {
  it("fails when no token can be produced", async () => {
    const result = await runDoctorChecks(deps({ getSessionToken: async () => null }));
    const check = idOf(result, "session");
    expect(check.ok).toBe(false);
    expect(check.line).toContain(AUTH_COMMAND);
  });

  it("fails cleanly when getSessionToken throws", async () => {
    const result = await runDoctorChecks(
      deps({
        getSessionToken: async () => {
          throw new Error("token service request failed");
        },
      })
    );
    expect(idOf(result, "session").ok).toBe(false);
  });

  it("skips the courses check with a sign-in-specific reason when session fails", async () => {
    const result = await runDoctorChecks(deps({ getSessionToken: async () => null }));
    const check = idOf(result, "courses");
    expect(check.ok).toBe(false);
    expect(check.line).toContain("Skipped");
    expect(check.line).toContain("sign-in");
  });
});

describe("doctor: (f) one real course-list call", () => {
  it("fails with the underlying error message", async () => {
    const result = await runDoctorChecks(
      deps({
        countCourses: async () => {
          throw new Error("API error (403) at /enrollments: Forbidden");
        },
      })
    );
    const check = idOf(result, "courses");
    expect(check.ok).toBe(false);
    expect(check.line).toContain("Forbidden");
  });

  it("never runs the course check when getSessionToken already failed", async () => {
    let called = false;
    await runDoctorChecks(
      deps({
        getSessionToken: async () => null,
        countCourses: async () => {
          called = true;
          return 1;
        },
      })
    );
    expect(called).toBe(false);
  });
});

describe("doctor: (g) version check", () => {
  it("passes and reports up to date", async () => {
    const result = await runDoctorChecks(deps({ installedVersion: "3.9.9", fetchLatestVersion: async () => "3.9.9" }));
    const check = idOf(result, "version");
    expect(check.ok).toBe(true);
    expect(check.line).toContain("latest version");
    expect(check.line).toContain("3.9.9");
  });

  it("fails and names both versions plus an npx-cache next step", async () => {
    const result = await runDoctorChecks(
      deps({ installedVersion: "3.9.9", fetchLatestVersion: async () => "3.10.0", installKind: "npx-cache" })
    );
    const check = idOf(result, "version");
    expect(check.ok).toBe(false);
    expect(check.line).toContain("3.9.9");
    expect(check.line).toContain("3.10.0");
    expect(check.line).toContain(CLEAR_NPX_CACHE_COMMAND);
  });

  it("tells a global npm install to upgrade with the global-install command", async () => {
    const result = await runDoctorChecks(
      deps({ installedVersion: "3.9.9", fetchLatestVersion: async () => "3.10.0", installKind: "npm-install" })
    );
    expect(idOf(result, "version").line).toContain(GLOBAL_INSTALL_COMMAND);
  });

  it("tells a source checkout to git pull and rebuild", async () => {
    const result = await runDoctorChecks(
      deps({ installedVersion: "3.9.9", fetchLatestVersion: async () => "3.10.0", installKind: "source-checkout" })
    );
    const check = idOf(result, "version");
    expect(check.ok).toBe(false);
    expect(check.line).toContain("npm run build");
  });

  it("notes a source checkout even when it is up to date", async () => {
    const result = await runDoctorChecks(
      deps({ installedVersion: "3.9.9", fetchLatestVersion: async () => "3.9.9", installKind: "source-checkout" })
    );
    const check = idOf(result, "version");
    expect(check.ok).toBe(true);
    expect(check.line).toContain("source checkout");
  });

  it("passes quietly when the registry cannot be reached — never fails for being offline", async () => {
    const result = await runDoctorChecks(deps({ fetchLatestVersion: async () => null }));
    const check = idOf(result, "version");
    expect(check.ok).toBe(true);
    expect(check.line).toContain("offline");
  });

  it("passes quietly when fetchLatestVersion itself throws", async () => {
    const result = await runDoctorChecks(
      deps({
        fetchLatestVersion: async () => {
          throw new Error("network down");
        },
      })
    );
    expect(idOf(result, "version").ok).toBe(true);
  });
});

describe("doctor: never prints secrets", () => {
  it("never includes the password in any line, even on failure", async () => {
    const result = await runDoctorChecks(
      deps({ getStoredPassword: async () => "super-secret-password-value" })
    );
    const text = result.checks.map((c) => c.line).join("\n");
    expect(text).not.toContain("super-secret-password-value");
  });

  it("never includes a raw token value", async () => {
    const result = await runDoctorChecks(
      deps({ getSessionToken: async () => ({ accessToken: "secret-jwt-value", capturedAt: 0, expiresAt: 0, source: "cache" as const }) })
    );
    const text = result.checks.map((c) => c.line).join("\n");
    expect(text).not.toContain("secret-jwt-value");
  });
});
