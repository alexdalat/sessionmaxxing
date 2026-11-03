import { expect, it } from "vitest";
import {
  formatListenUrl,
  resolveAllowedHosts,
  resolveEdition,
  resolveHost,
  resolveTimeZone,
} from "../server/environment.js";
import { DomainError } from "../server/storage.js";

const HOST = "SESSIONMAXXING_HOST";
const EDITION = "SESSIONMAXXING_EDITION";
const ALLOWED = "SESSIONMAXXING_ALLOWED_HOSTS";

it("binds loopback when SESSIONMAXXING_HOST is unset", () => {
  expect(resolveHost({})).toBe("127.0.0.1");
});
it.each(["0.0.0.0", "192.0.2.10", "::", "::1", "fe80::1"])(
  "accepts the IP literal %s as SESSIONMAXXING_HOST",
  (host) => {
    expect(resolveHost({ [HOST]: host })).toBe(host);
  },
);
it.each(["", "localhost", "0.0.0.0 ", "192.0.2.10:4317", "example.test"])(
  "rejects SESSIONMAXXING_HOST=%j naming the variable",
  (host) => {
    const attempt = () => resolveHost({ [HOST]: host });
    expect(attempt).toThrow(DomainError);
    expect(attempt).toThrow(HOST);
  },
);

it.each([[{}], [{ [EDITION]: "full" }]])(
  "resolves the edition from %j to full",
  (env) => {
    expect(resolveEdition(env)).toBe("full");
  },
);
it.each(["lite", "", "FULL"])(
  "rejects SESSIONMAXXING_EDITION=%j naming the variable",
  (edition) => {
    const attempt = () => resolveEdition({ [EDITION]: edition });
    expect(attempt).toThrow(DomainError);
    expect(attempt).toThrow(EDITION);
  },
);

it("approves only the bind address when no hosts are listed", () => {
  expect(resolveAllowedHosts({}, "127.0.0.1")).toEqual(["127.0.0.1"]);
});
it("trims entries, drops empty ones and never adds the unspecified bind address", () => {
  expect(
    resolveAllowedHosts(
      { [ALLOWED]: "a.example.test, ,b.example.test," },
      "0.0.0.0",
    ),
  ).toEqual(["a.example.test", "b.example.test"]);
});
it("does not add :: as an approved host", () => {
  expect(resolveAllowedHosts({}, "::")).toEqual([]);
});
it("lists the bind address first, then the configured entries", () => {
  expect(resolveAllowedHosts({ [ALLOWED]: "::1" }, "192.0.2.10")).toEqual([
    "192.0.2.10",
    "::1",
  ]);
});
it("accepts a bracketed IPv6 entry", () => {
  expect(resolveAllowedHosts({ [ALLOWED]: "[::1]" }, "127.0.0.1")).toEqual([
    "127.0.0.1",
    "[::1]",
  ]);
});
it.each([
  "example.test:4317",
  "example.test/path",
  "user@example.test",
  "bad host",
  "ex*ample.test",
  "-example.test",
  "example.test.-",
  "[example]",
])(
  "rejects the allowed-host entry %j naming the variable and the entry",
  (entry) => {
    const attempt = () =>
      resolveAllowedHosts({ [ALLOWED]: `ok.test,${entry}` }, "127.0.0.1");
    expect(attempt).toThrow(DomainError);
    expect(attempt).toThrow(ALLOWED);
    expect(attempt).toThrow(`"${entry}"`);
  },
);

it("formats an IPv4 listen address", () => {
  expect(
    formatListenUrl({ address: "127.0.0.1", family: "IPv4", port: 4317 }),
  ).toBe("http://127.0.0.1:4317");
});
it("brackets an IPv6 listen address", () => {
  expect(formatListenUrl({ address: "::1", family: "IPv6", port: 4317 })).toBe(
    "http://[::1]:4317",
  );
});

it.each([
  [{ TZ: "Asia/Kolkata" }, "Asia/Calcutta"],
  [{ TZ: ":America/Chicago" }, "America/Chicago"],
  [{}, "Europe/Berlin"],
  [{ TZ: "UTC" }, "UTC"],
])("accepts the resolved zone %s for env %j", (env, resolved) => {
  expect(resolveTimeZone(env, resolved)).toBe(resolved);
});
it.each([
  [{ TZ: "Foo/Bar" }, undefined],
  [{}, undefined],
  [{ TZ: "" }, "Etc/Unknown"],
  [{ TZ: "PST8PDT,M3.2.0,M11.1.0" }, "UTC"],
  [{ TZ: "Asia/Kolkata" }, "UTC"],
])("rejects env %j with resolved zone %s naming TZ", (env, resolved) => {
  const attempt = () => resolveTimeZone(env, resolved);
  expect(attempt).toThrow(DomainError);
  expect(attempt).toThrow("TZ");
});
