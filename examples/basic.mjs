import { setTimeout as sleep } from "node:timers/promises";

import { createLaqu } from "@0disoft/laqu";

const progress = createLaqu({
  maxRows: 8,
  theme: {
    runningSymbol: "›",
    successSymbol: "✓",
    progressComplete: "█",
    progressIncomplete: "░",
    overflowMarker: "…",
  },
});

const install = progress.createTask("install packages", { total: 100, message: "resolving" });
const build = progress.createTask("build artifacts", { total: 100, message: "waiting" });
const publish = progress.createTask("publish preview", { total: 100, message: "waiting" });

for (let value = 0; value <= 100; value += 2) {
  install.setCompleted(value);
  install.setMessage(value < 100 ? "downloading" : "ready");
  install.setDetail(`${value}/100`);

  if (value >= 24) {
    build.setCompleted(Math.min(100, (value - 24) * 1.35));
    build.setMessage(value < 92 ? "bundling" : "ready");
  }

  if (value >= 56) {
    publish.setCompleted(Math.min(100, (value - 56) * 2.3));
    publish.setMessage(value < 100 ? "uploading" : "ready");
  }

  await sleep(120);
}

install.succeed("done");
build.succeed("done");
publish.succeed("done");

progress.log("all tasks completed");
await progress.close();
