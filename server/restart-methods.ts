import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  RESTART_ARG_MAX,
  RESTART_ARGV_MAX,
  type RestartMethod,
} from "../shared/types.js";
import { atomicJson, DomainError, exactKeys } from "./storage.js";

export const RESTART_METHODS_FILE = "restart-methods.json";
const VERSION = 1;
const FORBIDDEN_CHARACTERS = /[\0\r\n]/;
const NONE: RestartMethod = { kind: "none" };

/** The one check for a restart method, shared by the loader and the route. */
export function validateRestartMethod(
  value: unknown,
  statusCode: number,
): RestartMethod {
  if (
    exactKeys(value, ["kind"]) &&
    (value.kind === "none" || value.kind === "compose")
  )
    return { kind: value.kind };
  if (!exactKeys(value, ["kind", "argv"]) || value.kind !== "command")
    throw new DomainError(
      'A restart method is { kind: "none" }, { kind: "compose" } or { kind: "command", argv }.',
      statusCode,
    );
  const { argv } = value;
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > RESTART_ARGV_MAX)
    throw new DomainError(
      `A restart command has 1 to ${RESTART_ARGV_MAX} arguments.`,
      statusCode,
    );
  for (const [index, argument] of argv.entries()) {
    const position = `Argument ${index + 1} of the restart command`;
    if (typeof argument !== "string")
      throw new DomainError(`${position} is not text.`, statusCode);
    if (argument.length < 1 || argument.length > RESTART_ARG_MAX)
      throw new DomainError(
        `${position} has to be 1 to ${RESTART_ARG_MAX} characters long.`,
        statusCode,
      );
    if (FORBIDDEN_CHARACTERS.test(argument))
      throw new DomainError(
        `${position} contains a NUL character or a line break.`,
        statusCode,
      );
  }
  return { kind: "command", argv: [...(argv as string[])] };
}

const invalidFile = (reason: string) =>
  new DomainError(
    `${RESTART_METHODS_FILE} is invalid: ${reason} Restore a valid ${RESTART_METHODS_FILE} before starting.`,
    500,
  );

function methodsOf(file: unknown): Map<string, RestartMethod> {
  if (!exactKeys(file, ["version", "methods"]) || file.version !== VERSION)
    throw invalidFile(`it is not a version ${VERSION} methods file.`);
  const { methods } = file;
  if (methods === null || typeof methods !== "object" || Array.isArray(methods))
    throw invalidFile("methods is not an object.");
  const parsed = new Map<string, RestartMethod>();
  for (const [workdir, value] of Object.entries(methods)) {
    if (!isAbsolute(workdir))
      throw invalidFile(`${workdir} is not an absolute work directory.`);
    let method: RestartMethod;
    try {
      method = validateRestartMethod(value, 500);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      throw invalidFile(`the method of ${workdir}: ${error.message}`);
    }
    if (method.kind === "none")
      throw invalidFile(`${workdir} stores none, which is never written.`);
    parsed.set(workdir, method);
  }
  return parsed;
}

/** The restart method of each work directory, keyed by its realpath; a directory without an entry restarts with none. */
export class RestartMethodStore {
  private chain: Promise<unknown> = Promise.resolve();
  private constructor(
    private path: string,
    private methods: Map<string, RestartMethod>,
  ) {}
  /** Reads the file; without one, stores what `initial` returns, writing the file as the last step. */
  static async open(
    directory: string,
    initial: () => Promise<Record<string, RestartMethod>>,
  ) {
    const path = join(directory, RESTART_METHODS_FILE);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const file = { version: VERSION, methods: await initial() };
      const methods = methodsOf(file);
      await atomicJson(path, file);
      return new RestartMethodStore(path, methods);
    }
    let file: unknown;
    try {
      file = JSON.parse(text);
    } catch {
      throw invalidFile("it is not JSON.");
    }
    return new RestartMethodStore(path, methodsOf(file));
  }
  get(workdir: string): RestartMethod {
    return structuredClone(this.methods.get(workdir) ?? NONE);
  }
  async set(workdir: string, value: RestartMethod): Promise<RestartMethod> {
    const method = validateRestartMethod(value, 400);
    if (!isAbsolute(workdir))
      throw new DomainError(
        "A restart method belongs to an absolute work directory.",
        400,
      );
    const operation = this.chain.then(async () => {
      const methods = new Map(this.methods);
      if (method.kind === "none") methods.delete(workdir);
      else methods.set(workdir, method);
      await atomicJson(this.path, {
        version: VERSION,
        methods: Object.fromEntries(methods),
      });
      this.methods = methods;
      return structuredClone(method);
    });
    this.chain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
