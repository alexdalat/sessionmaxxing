import { execFileSync } from "node:child_process";

const result = execFileSync(
  "agent-browser",
  ["--session", "sessionmaxxing", "eval", "--stdin"],
  {
    encoding: "utf8",
    input: `JSON.stringify({ viewport: document.documentElement.clientWidth, width: document.documentElement.scrollWidth, metricsFit: [...document.querySelectorAll('.stat')].every(element => element.scrollWidth <= element.clientWidth) })`,
  },
);
const parsed = JSON.parse(result);
const metrics = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
if (metrics.width > metrics.viewport || !metrics.metricsFit)
  throw new Error(`Mobile layout overflow: ${JSON.stringify(metrics)}`);
console.log(`PASS: no page or metric overflow at ${metrics.viewport}px.`);
