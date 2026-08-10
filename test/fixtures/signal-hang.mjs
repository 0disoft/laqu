import { createLaqu } from "../../dist-test/src/index.js";

const runtime = createLaqu({
  manageProcessLifecycle: true,
  streamCapability: "pipe",
});

void runtime.task("never-finishes", async () => {
  process.send?.("ready");
  await new Promise(() => {});
});

process.on("message", (message) => {
  if (message === "interrupt") {
    process.emit("SIGINT", "SIGINT");
  }
});
