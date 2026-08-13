import { createLaqu } from "@0disoft/laqu";

const progress = createLaqu();

await progress.task("release", async (release) => {
  const checks = release.child("checks", { total: 2 });
  checks.advance(1);
  checks.setMessage("types passed");
  checks.advance(1);
  checks.succeed("all checks passed");

  const publish = release.child("publish", { total: 2 });
  publish.advance(1);
  publish.setMessage("package uploaded");
  publish.advance(1);
  publish.succeed("release published");
});

await progress.close();
