import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_DISPATCH_SETTINGS,
  type DispatchSettings,
  MAX_QUIET_START_HOURS,
  MAX_SESSION_RESERVE_PERCENT,
  MAX_WEEKLY_MARGIN_PERCENT,
} from "../shared/types.js";
import { atomicJson, DomainError, exactKeys } from "./storage.js";

const KEYS = [
  "sessionReservePercent",
  "weeklyMarginPercent",
  "quietHoursOnly",
  "quietStartHours",
] as const;
function numeric(value: unknown, max: number) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max
  );
}
export function validateSettings(
  value: unknown,
): asserts value is DispatchSettings {
  if (
    !exactKeys(value, KEYS) ||
    !numeric(value.sessionReservePercent, MAX_SESSION_RESERVE_PERCENT) ||
    !numeric(value.weeklyMarginPercent, MAX_WEEKLY_MARGIN_PERCENT) ||
    typeof value.quietHoursOnly !== "boolean" ||
    !Number.isInteger(value.quietStartHours) ||
    !numeric(value.quietStartHours, MAX_QUIET_START_HOURS) ||
    (value.quietStartHours as number) < 1
  )
    throw new DomainError(
      `Dispatch settings need a session reserve from 0 to ${MAX_SESSION_RESERVE_PERCENT}%, a weekly margin from 0 to ${MAX_WEEKLY_MARGIN_PERCENT}%, a quiet-hours flag, and 1 to ${MAX_QUIET_START_HOURS} quiet start hours.`,
      400,
    );
}
export const settingsSchema = {
  type: "object",
  additionalProperties: false,
  required: [...KEYS],
  properties: {
    sessionReservePercent: {
      type: "number",
      minimum: 0,
      maximum: MAX_SESSION_RESERVE_PERCENT,
    },
    weeklyMarginPercent: {
      type: "number",
      minimum: 0,
      maximum: MAX_WEEKLY_MARGIN_PERCENT,
    },
    quietHoursOnly: { type: "boolean" },
    quietStartHours: {
      type: "integer",
      minimum: 1,
      maximum: MAX_QUIET_START_HOURS,
    },
  },
};
export const emptyQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

export class DispatchSettingsStore {
  private chain: Promise<unknown> = Promise.resolve();
  private constructor(
    private path: string,
    private state: DispatchSettings,
  ) {}

  static async open(directory: string) {
    const path = join(directory, "dispatch-settings.json");
    let state: DispatchSettings;
    try {
      state = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { ...DEFAULT_DISPATCH_SETTINGS };
      await atomicJson(path, state);
    }
    // Settings saved before quiet hours existed gain the defaults for the new keys.
    if (
      state !== null &&
      typeof state === "object" &&
      !Array.isArray(state) &&
      Object.keys(state).every((key) =>
        (KEYS as readonly string[]).includes(key),
      ) &&
      Object.keys(state).length < KEYS.length
    ) {
      state = { ...DEFAULT_DISPATCH_SETTINGS, ...state };
      await atomicJson(path, state);
    }
    try {
      validateSettings(state);
    } catch {
      throw new DomainError(
        "Saved dispatch settings are invalid. Restore or remove dispatch-settings.json.",
        500,
      );
    }
    return new DispatchSettingsStore(path, state);
  }

  snapshot(): DispatchSettings {
    return structuredClone(this.state);
  }

  async save(settings: DispatchSettings) {
    validateSettings(settings);
    const draft = structuredClone(settings);
    const operation = this.chain.then(async () => {
      await atomicJson(this.path, draft);
      this.state = draft;
      return this.snapshot();
    });
    this.chain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
