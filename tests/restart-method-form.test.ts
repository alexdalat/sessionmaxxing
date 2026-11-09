import { describe, expect, it } from "vitest";
import {
  argvFromText,
  RESTART_KIND_LABELS,
  restartDraft,
  sameRestartMethod,
  textFromArgv,
} from "../app/lib/restart-method";

describe("argvFromText", () => {
  it("splits on line breaks and keeps spaces around an argument", () => {
    expect(argvFromText("./deploy.sh\n --flag \nlast")).toEqual([
      "./deploy.sh",
      " --flag ",
      "last",
    ]);
  });

  it("strips one trailing carriage return per line and keeps the empty last argument", () => {
    expect(argvFromText("a\r\nb\r\n")).toEqual(["a", "b", ""]);
  });

  it("keeps empty lines between arguments", () => {
    expect(argvFromText("a\n\nb")).toEqual(["a", "", "b"]);
  });

  it("returns one argument for a single line", () => {
    expect(argvFromText("one")).toEqual(["one"]);
  });
});

describe("textFromArgv", () => {
  it.each(["one", "a\nb\nc", "a\n\nb\n", " padded \nnext"])(
    "restores the text %j",
    (text) => {
      expect(textFromArgv(argvFromText(text))).toBe(text);
    },
  );
});

describe("restartDraft", () => {
  it("builds each kind of method", () => {
    expect(restartDraft("none", "ignored")).toEqual({ kind: "none" });
    expect(restartDraft("compose", "ignored")).toEqual({ kind: "compose" });
    expect(restartDraft("command", "./a\nb")).toEqual({
      kind: "command",
      argv: ["./a", "b"],
    });
  });
});

describe("sameRestartMethod", () => {
  it("is true for command methods with equal arguments", () => {
    expect(
      sameRestartMethod(
        { kind: "command", argv: ["a", "b"] },
        { kind: "command", argv: ["a", "b"] },
      ),
    ).toBe(true);
  });

  it("is false when one argument differs", () => {
    expect(
      sameRestartMethod(
        { kind: "command", argv: ["a", "b"] },
        { kind: "command", argv: ["a", "c"] },
      ),
    ).toBe(false);
  });

  it("is false when the argument counts differ", () => {
    expect(
      sameRestartMethod(
        { kind: "command", argv: ["a"] },
        { kind: "command", argv: ["a", ""] },
      ),
    ).toBe(false);
  });

  it("is false between different kinds", () => {
    expect(sameRestartMethod({ kind: "compose" }, { kind: "none" })).toBe(
      false,
    );
  });

  it("is true for two methods of a kind without arguments", () => {
    expect(sameRestartMethod({ kind: "compose" }, { kind: "compose" })).toBe(
      true,
    );
  });
});

it("labels the three kinds", () => {
  expect(RESTART_KIND_LABELS).toEqual({
    none: "None",
    compose: "Docker Compose",
    command: "Command",
  });
});
