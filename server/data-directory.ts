import { lstat, mkdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DomainError } from "./storage.js";

export const DATA_DIR_VARIABLE = "SESSIONMAXXING_DATA_DIR";
export const LOCK_FILE = "server.lock";
const APP_DIRECTORY = "sessionmaxxing";
const LEGACY_DIRECTORY = "data";
const PRIVATE_DIRECTORY_MODE = 0o700;

export type Env = Readonly<Record<string, string | undefined>>;
type Move = (from: string, to: string) => Promise<void>;

export function resolveDataDirectory(env: Env, home: string) {
  const explicit = env[DATA_DIR_VARIABLE];
  if (explicit !== undefined) {
    if (!isAbsolute(explicit))
      throw new DomainError(
        `${DATA_DIR_VARIABLE} must be an absolute path.`,
        400,
      );
    return explicit;
  }
  const xdg = env.XDG_DATA_HOME;
  const base =
    xdg !== undefined && xdg !== "" && isAbsolute(xdg)
      ? xdg
      : join(home, ".local", "share");
  return join(base, APP_DIRECTORY);
}

const quote = (path: string) => `'${path.replaceAll("'", `'\\''`)}'`;

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

export async function moveLegacyData(
  legacy: string,
  target: string,
  move: Move = rename,
) {
  if (resolve(legacy) === resolve(target)) return;
  if (!(await exists(legacy))) return;
  if (!(await lstat(legacy)).isDirectory())
    throw new DomainError(
      `${legacy} is not a directory. Move or remove it by hand, then start again.`,
    );
  if (
    contains(resolve(legacy), resolve(target)) ||
    contains(resolve(target), resolve(legacy))
  )
    throw new DomainError(
      `${legacy} and ${target} are nested inside each other. Choose a data directory outside ${legacy}.`,
    );
  const lockPath = join(legacy, LOCK_FILE);
  if (await exists(lockPath))
    throw new DomainError(
      `${lockPath} exists, so a dashboard may still be running against ${legacy}. Stop that server first.`,
    );
  if (await exists(target))
    throw new DomainError(
      `Both ${legacy} and ${target} exist. Merge or remove one of them, then start again.`,
    );
  await mkdir(dirname(target), {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  try {
    await move(legacy, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV")
      throw new DomainError(
        `${legacy} and ${target} are on different filesystems. Stop the dashboard and run: mv ${quote(legacy)} ${quote(target)}`,
      );
    throw error;
  }
}

export async function prepareDataDirectory(options: {
  explicit: string | undefined;
  env: Env;
  home: string;
  cwd: string;
}) {
  if (options.explicit !== undefined) return options.explicit;
  const target = resolveDataDirectory(options.env, options.home);
  await moveLegacyData(join(options.cwd, LEGACY_DIRECTORY), target);
  return target;
}
