import { createLaqu } from "laqu";
import { LAQU_EVENT_SCHEMA_VERSION } from "laqu/events";
import { compileTheme } from "laqu/theme";
import { displayWidth } from "laqu/width";

if (typeof createLaqu !== "function") {
  throw new TypeError("createLaqu export is not callable");
}

if (LAQU_EVENT_SCHEMA_VERSION !== 1) {
  throw new Error("unexpected laqu event schema version");
}

if (displayWidth("한") !== 2) {
  throw new Error("width subpath export is not functional");
}

if (compileTheme({ useColor: false }).tokens.successSymbol.length === 0) {
  throw new Error("theme subpath export is not functional");
}
