import {
  createLaqu,
  renderSegments,
  text,
  type ProgressRuntime,
  type RenderableSegment,
} from "laqu";
import { LAQU_EVENT_SCHEMA, LAQU_EVENT_SCHEMA_VERSION, type LaquEvent } from "laqu/events";
import { compileTheme, type CompiledTheme } from "laqu/theme";
import { displayWidth, tokenizeAnsi, type AnsiToken, type WidthOptions } from "laqu/width";

const runtime: ProgressRuntime = createLaqu({
  format: "json",
  progressPolicy: "silent",
  manageProcessLifecycle: false,
});
const task = runtime.createTask("consumer types", { ratio: 0.25 });
task.setPercent(50);

const event: LaquEvent = {
  schema: LAQU_EVENT_SCHEMA,
  version: LAQU_EVENT_SCHEMA_VERSION,
  type: "log",
  createdAt: 0,
  message: "ready",
};

const theme: CompiledTheme = compileTheme({ useColor: false });
const segments: readonly RenderableSegment[] = [text("ready", "success")];
const rendered: string = renderSegments(theme, segments);

const widthOptions: WidthOptions = { ambiguousWidth: 2, tabSize: 4 };
const width: number = displayWidth("¡", widthOptions);
const tokenKinds: readonly AnsiToken["kind"][] = tokenizeAnsi("\u001b[32mok\u001b[0m").map(
  (token) => token.kind,
);

await runtime.close();

void event;
void rendered;
void width;
void tokenKinds;
