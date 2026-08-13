import { createLaqu } from "@0disoft/laqu";

const progress = createLaqu({ format: "ndjson" });

await progress.task("index files", { total: 2 }, async (task) => {
  task.advance(1);
  task.setMessage("sources indexed");
  task.advance(1);
});

await progress.close();
