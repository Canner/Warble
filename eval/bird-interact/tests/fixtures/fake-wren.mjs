#!/usr/bin/env node

import { writeFileSync } from "node:fs";

if (process.env.FAKE_WREN_RECORD) {
  writeFileSync(
    process.env.FAKE_WREN_RECORD,
    JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }),
    "utf8",
  );
}

if (process.env.FAKE_WREN_EXIT) {
  process.stderr.write(process.env.FAKE_WREN_STDERR ?? "planning failed");
  process.exit(Number(process.env.FAKE_WREN_EXIT));
}

if (process.env.FAKE_WREN_DELAY_MS) {
  await new Promise((resolve) =>
    setTimeout(resolve, Number(process.env.FAKE_WREN_DELAY_MS)),
  );
}

process.stdout.write(process.env.FAKE_WREN_STDOUT ?? "SELECT planned_native");
