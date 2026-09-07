import { expect, it } from "vitest";
import { hourLabel, shortHourLabel } from "../shared/types.js";

it("labels 24-hour clock hours as 12-hour text with a meridiem", () => {
  expect(hourLabel(0)).toBe("12 AM");
  expect(hourLabel(11)).toBe("11 AM");
  expect(hourLabel(12)).toBe("12 PM");
  expect(hourLabel(13)).toBe("1 PM");
  expect(hourLabel(23)).toBe("11 PM");
});

it("abbreviates hours for narrow columns", () => {
  expect(shortHourLabel(0)).toBe("12a");
  expect(shortHourLabel(11)).toBe("11a");
  expect(shortHourLabel(12)).toBe("12p");
  expect(shortHourLabel(23)).toBe("11p");
});
