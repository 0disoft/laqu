import { createLaqu } from "@0disoft/laqu";

const progress = createLaqu();

const artifact = await progress.task("build release", { total: 3 }, async (task) => {
  task.advance(1);
  task.setMessage("types checked");
  task.advance(1);
  task.setMessage("bundle written");
  task.advance(1);

  return { artifact: "dist/laqu.js", status: "ready" };
});

await progress.close();
process.stdout.write(`${JSON.stringify(artifact)}\n`);
