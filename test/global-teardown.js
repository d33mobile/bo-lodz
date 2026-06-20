import MCR from "monocart-coverage-reports";
import { coverageOptions } from "./coverage-options.js";

// Runs once after all spec files. The spec adds raw V8 coverage to MCR's cache
// during the run; here we materialise the final report (v8 HTML, console
// summary, json-summary, lcov) into coverage-e2e/.
export default async function globalTeardown() {
  const mcr = MCR(coverageOptions);
  await mcr.generate();
}
