import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const file = process.argv[2] ?? (existsSync(".env") ? ".env" : ".env.local");
const content = await readFile(file, "utf8");
const prior = parseEnv(content).MAIL_ENCRYPTION_KEY;
if (prior) {
  if (Buffer.from(prior, "base64").length !== 32) throw new Error("MAIL_ENCRYPTION_KEY is invalid. Do not rotate a key used by existing Gmail connections.");
  console.log(`MAIL_ENCRYPTION_KEY already exists in ${file}; preserved it.`);
} else {
  const line = `MAIL_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`;
  const next = /^MAIL_ENCRYPTION_KEY=.*$/m.test(content) ? content.replace(/^MAIL_ENCRYPTION_KEY=.*$/m, () => line) : `${content.trimEnd()}\n${line}\n`;
  await writeFile(file, next, { mode: 0o600 });
  await chmod(file, 0o600);
  console.log(`Configured MAIL_ENCRYPTION_KEY in ${file}; the key was not printed. Store the same key in your app host's secret environment settings.`);
}
