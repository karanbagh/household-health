import { cp } from "node:fs/promises";

await cp(new URL("../web", import.meta.url), new URL("../dist/web", import.meta.url), { recursive: true });
console.log("Built server and copied web assets to dist/");
