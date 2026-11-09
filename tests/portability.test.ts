import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_VALUES } from "./forbidden-values";

const ENV_KEYS = [
  "SESSIONMAXXING_UID",
  "SESSIONMAXXING_GID",
  "SESSIONMAXXING_DOCKER_GID",
  "SESSIONMAXXING_HOME",
  "SESSIONMAXXING_BIND_ADDRESS",
  "SESSIONMAXXING_PORT",
  "SESSIONMAXXING_EDITION",
  "TZ",
  "SESSIONMAXXING_ALLOWED_HOSTS",
];
const OPTIONAL_KEY = "SESSIONMAXXING_ALLOWED_HOSTS";
const PORTABLE_FILES = [
  "compose.yaml",
  ".env.example",
  "Dockerfile",
  "deploy/host-deploy.sh",
  "deploy/claude-dashboard-deploy.path",
];
const INTERPOLATION = /\$\{([A-Z][A-Z0-9_]*)(:[?-][^}]*)?\}/g;

const read = (path: string) => readFile(resolve(path), "utf8");

function interpolations(text: string) {
  return [...text.matchAll(INTERPOLATION)].map((match) => ({
    name: match[1],
    modifier: match[2] ?? "",
  }));
}

function lines(text: string) {
  return text.split("\n");
}

describe("compose.yaml", () => {
  it("requires every field with a :? error except the optional extra hosts", async () => {
    const found = interpolations(await read("compose.yaml"));
    expect(found.length).toBeGreaterThan(0);
    for (const { name, modifier } of found) {
      if (name === OPTIONAL_KEY) expect(modifier).toBe(":-");
      else expect(modifier, `${name} must be required`).toMatch(/^:\?\S/);
    }
    expect(found.some((entry) => entry.name === OPTIONAL_KEY)).toBe(true);
  });

  it("approves the bind address followed by the optional extra names", async () => {
    const line = lines(await read("compose.yaml")).find((candidate) =>
      candidate.includes(`${OPTIONAL_KEY}:`),
    );
    expect(line).toMatch(
      /SESSIONMAXXING_ALLOWED_HOSTS: "\$\{SESSIONMAXXING_BIND_ADDRESS:\?[^}]+\},\$\{SESSIONMAXXING_ALLOWED_HOSTS:-\}"/,
    );
  });

  it("publishes exactly one port from interpolated values", async () => {
    const text = await read("compose.yaml");
    const published = lines(text).filter((line) => /^\s*published:/.test(line));
    expect(published).toHaveLength(1);
    expect(published[0]).toContain("${SESSIONMAXXING_PORT:?");
    expect(text).toMatch(/host_ip: "\$\{SESSIONMAXXING_BIND_ADDRESS:\?/);
    expect(text).toMatch(/target: 4317\b/);
  });

  it("leaves the image to set the in-container host and port", async () => {
    const text = await read("compose.yaml");
    expect(text).not.toMatch(/^\s*SESSIONMAXXING_HOST:/m);
    expect(text).not.toMatch(/^\s*SESSIONMAXXING_PORT:/m);
  });

  it("mounts only the home directory and the docker socket, with no data directory", async () => {
    const text = await read("compose.yaml");
    expect(text.match(/type: bind/g)).toHaveLength(2);
    expect(text.match(/create_host_path: false/g)).toHaveLength(2);
    expect(text).not.toContain("./data");
    expect(text).not.toContain("/app/data");
    expect(text).toMatch(/source: "\$\{SESSIONMAXXING_HOME:\?[^}]+\}"/);
    expect(text).toMatch(/target: "\$\{SESSIONMAXXING_HOME:\?[^}]+\}"/);
    expect(text).toMatch(/^\s*source: \/var\/run\/docker\.sock$/m);
    expect(text).toMatch(/^\s*target: \/var\/run\/docker\.sock$/m);
  });

  it("adds the socket group through one quoted group_add entry that names the command printing it", async () => {
    const text = await read("compose.yaml");
    const entries = lines(text).filter((line) =>
      line.includes("SESSIONMAXXING_DOCKER_GID"),
    );
    expect(entries).toHaveLength(1);
    expect(text).toMatch(/^\s*group_add:\s*$/m);
    expect(entries[0]).toMatch(
      /^\s*- "\$\{SESSIONMAXXING_DOCKER_GID:\?[^}]*stat -c %g \/var\/run\/docker\.sock[^}]*\}"$/,
    );
  });

  it("adds no proxy, privileged mode or capability", async () => {
    const text = await read("compose.yaml");
    for (const option of ["privileged", "cap_add", "docker-socket-proxy"])
      expect(text).not.toContain(option);
  });

  it("takes the container user and the build args from the same fields", async () => {
    const text = await read("compose.yaml");
    expect(text).toMatch(
      /^\s*user: "\$\{SESSIONMAXXING_UID:\?[^}]+\}:\$\{SESSIONMAXXING_GID:\?[^}]+\}"/m,
    );
    for (const [arg, key] of [
      ["RUNTIME_UID", "SESSIONMAXXING_UID"],
      ["RUNTIME_GID", "SESSIONMAXXING_GID"],
      ["RUNTIME_HOME", "SESSIONMAXXING_HOME"],
    ])
      expect(text).toMatch(new RegExp(`${arg}: "\\$\\{${key}:\\?`));
  });

  it("passes the zone and edition into the container", async () => {
    const text = await read("compose.yaml");
    expect(text).toMatch(/^\s*TZ: "\$\{TZ:\?/m);
    expect(text).toMatch(
      /^\s*SESSIONMAXXING_EDITION: "\$\{SESSIONMAXXING_EDITION:\?/m,
    );
  });
});

describe(".env.example", () => {
  it("lists exactly the nine Compose fields", async () => {
    const keys = lines(await read(".env.example"))
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter((key): key is string => key !== undefined);
    expect(keys).toEqual(ENV_KEYS);
  });

  it("names every variable compose.yaml interpolates", async () => {
    const used = new Set(
      interpolations(await read("compose.yaml")).map((entry) => entry.name),
    );
    expect([...used].sort()).toEqual([...ENV_KEYS].sort());
  });

  it("starts the extra allowed hosts empty", async () => {
    expect(await read(".env.example")).toMatch(
      /^SESSIONMAXXING_ALLOWED_HOSTS=$/m,
    );
  });

  it("leaves the docker group empty and names the command that prints it", async () => {
    const text = await read(".env.example");
    expect(text).toMatch(/^SESSIONMAXXING_DOCKER_GID=$/m);
    expect(text).toContain("stat -c %g /var/run/docker.sock");
  });
});

describe(".gitignore", () => {
  it("keeps .env, compose.override.yaml and data/ out of git", async () => {
    const entries = lines(await read(".gitignore")).map((line) => line.trim());
    for (const entry of [".env", "compose.override.yaml", "data/"])
      expect(entries).toContain(entry);
  });
});

describe("personal values", () => {
  it.each(PORTABLE_FILES)("%s holds none", async (path) => {
    const text = await read(path);
    for (const pattern of FORBIDDEN_VALUES)
      expect(text, `${path} matches ${pattern}`).not.toMatch(pattern);
  });
});

describe("Dockerfile", () => {
  const runtimeStage = async () => {
    const text = await read("Dockerfile");
    return text.slice(text.lastIndexOf("FROM "));
  };

  it("declares the runtime ids and home as build args after the apt-get layer", async () => {
    const text = await runtimeStage();
    for (const arg of ["RUNTIME_UID", "RUNTIME_GID", "RUNTIME_HOME"])
      expect(text.indexOf(`ARG ${arg}`), arg).toBeGreaterThan(
        text.indexOf("apt-get install"),
      );
  });

  it("replaces existing owners of the ids and refuses root", async () => {
    const text = await runtimeStage();
    expect(text).toContain('getent passwd "$RUNTIME_UID"');
    expect(text).toContain("userdel");
    expect(text).toContain('getent group "$RUNTIME_GID"');
    expect(text).toContain("groupdel");
    expect(text.indexOf("groupdel")).toBeLessThan(text.indexOf("groupadd"));
    expect(text).toContain("for id in RUNTIME_UID RUNTIME_GID");
    expect(text).toContain('case "$(printenv "$id")" in \'\'|*[!0-9]*|0*)');
  });

  it("creates the user sessionmaxxing without a home and owns the home directory", async () => {
    const text = await runtimeStage();
    expect(text).toMatch(/useradd[^;]*--no-create-home/);
    expect(text).toMatch(/useradd[^;]*--home-dir "\$RUNTIME_HOME"/);
    expect(text).toMatch(/useradd[^;]*sessionmaxxing;/);
    expect(text).toMatch(/groupadd --gid "\$RUNTIME_GID" sessionmaxxing/);
    expect(text).toMatch(
      /install -d -m 0755 -o "\$RUNTIME_UID" -g "\$RUNTIME_GID" "\$RUNTIME_HOME"/,
    );
  });

  it("hardcodes no id, home path or data directory", async () => {
    const text = await runtimeStage();
    expect(text).not.toMatch(/(useradd|groupadd)[^\n]*--(uid|gid) [0-9]/);
    expect(text).not.toContain("/app/data");
    expect(text).not.toMatch(/HOME=\//);
  });

  it("keeps the image host and port and takes HOME from the build arg", async () => {
    const text = await runtimeStage();
    for (const entry of [
      "NODE_ENV=production",
      "SESSIONMAXXING_HOST=0.0.0.0",
      "SESSIONMAXXING_PORT=4317",
      "DISABLE_AUTOUPDATER=1",
    ])
      expect(text, entry).toContain(entry);
    expect(text).toMatch(/HOME=\$\{RUNTIME_HOME\}/);
  });

  it("installs the docker CLI, compose and buildx from Docker's signed repository before the ids are declared", async () => {
    const text = await runtimeStage();
    expect(text).toContain("download.docker.com/linux/debian");
    expect(text).toContain("Signed-By: /etc/apt/keyrings/docker.asc");
    for (const pkg of [
      "docker-ce-cli",
      "docker-compose-plugin",
      "docker-buildx-plugin",
    ])
      expect(text, pkg).toContain(pkg);
    const layer = text.indexOf("docker-ce-cli");
    expect(layer).toBeGreaterThan(text.indexOf("apt-get install"));
    expect(layer).toBeLessThan(text.indexOf("ARG RUNTIME_UID"));
  });

  it("marks the image as a Docker install", async () => {
    expect(await runtimeStage()).toMatch(/SESSIONMAXXING_IN_DOCKER=1/);
  });

  it("fails the build unless docker, compose and buildx run as the runtime user", async () => {
    const text = await runtimeStage();
    const guard = text.indexOf(
      "RUN docker --version && docker compose version && docker buildx version",
    );
    expect(guard).toBeGreaterThan(
      text.search(/USER \$\{RUNTIME_UID\}:\$\{RUNTIME_GID\}/),
    );
  });

  it("switches to the runtime user before running claude", async () => {
    const text = await runtimeStage();
    const user = text.search(/USER \$\{RUNTIME_UID\}:\$\{RUNTIME_GID\}/);
    expect(user).toBeGreaterThan(-1);
    expect(user).toBeLessThan(text.indexOf("RUN claude --version"));
  });
});

describe("host watcher", () => {
  const execFileAsync = promisify(execFile);
  const SCRIPT = "deploy/host-deploy.sh";

  async function resolvedPaths(env: Record<string, string>) {
    const script = await read(SCRIPT);
    const start = script.indexOf("case ");
    const end = script.indexOf('results="', start);
    const block = script.slice(start, script.indexOf("\n", end));
    const assignments = Object.entries(env).map(
      ([key, value]) => `${key}=${value}`,
    );
    const { stdout } = await execFileAsync("env", [
      "-i",
      ...assignments,
      "bash",
      "-c",
      `set -eu\n${block}\nprintf '%s\\n%s' "$requests" "$results"`,
    ]);
    const [requests, results] = stdout.split("\n");
    return { requests, results };
  }

  it("is valid bash", async () => {
    await execFileAsync("bash", ["-n", resolve(SCRIPT)]);
  });

  it("uses SESSIONMAXXING_DATA_DIR over everything else", async () => {
    expect(
      await resolvedPaths({
        HOME: "/home/user",
        XDG_DATA_HOME: "/xdg",
        SESSIONMAXXING_DATA_DIR: "/srv/state",
      }),
    ).toEqual({
      requests: "/srv/state/deploy/requests",
      results: "/srv/state/deploy/results",
    });
  });

  it("uses an absolute XDG_DATA_HOME next", async () => {
    expect(
      await resolvedPaths({ HOME: "/home/user", XDG_DATA_HOME: "/xdg" }),
    ).toEqual({
      requests: "/xdg/sessionmaxxing/deploy/requests",
      results: "/xdg/sessionmaxxing/deploy/results",
    });
  });

  it.each(["", "relative/data"])(
    "falls back to the home default when XDG_DATA_HOME is %j",
    async (xdg) => {
      expect(
        await resolvedPaths({ HOME: "/home/user", XDG_DATA_HOME: xdg }),
      ).toEqual({
        requests: "/home/user/.local/share/sessionmaxxing/deploy/requests",
        results: "/home/user/.local/share/sessionmaxxing/deploy/results",
      });
    },
  );

  it("keeps the repository path for the self-redeploy check and the loopback dashboard URL", async () => {
    const script = await read(SCRIPT);
    expect(script).toMatch(/^repo=".*"$/m);
    expect(script).toContain('= "$repo" ]');
    expect(script).toMatch(/\$\{DASHBOARD_URL:-http:\/\/127\.0\.0\.1:4317\}/);
    expect(script).not.toContain("$repo/data");
  });

  it("watches the default data directory and leaves ExecStart alone", async () => {
    const path = await read("deploy/claude-dashboard-deploy.path");
    expect(path).toContain(
      "PathExistsGlob=%h/.local/share/sessionmaxxing/deploy/requests/*.json",
    );
    expect(await read("deploy/claude-dashboard-deploy.service")).toContain(
      "ExecStart=%h/workspace/claude-capacity-dashboard/deploy/host-deploy.sh",
    );
  });
});
