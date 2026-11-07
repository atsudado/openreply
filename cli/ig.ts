import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { run } from "./commands";
import { UserError, getUploader, prepareImage } from "./media";

const envFile = resolve(__dirname, "../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

run(process.argv.slice(2), {
  env: process.env,
  stdout: (s) => console.log(s),
  stderr: (s) => console.error(s),
  prepareImage,
  getUploader,
  // Writes the new values into .env in place (atomic rename, owner-only), never printing them.
  saveEnv: async (vars) => {
    let text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
    for (const [key, value] of Object.entries(vars)) {
      const line = `${key}=${value}`;
      const re = new RegExp(`^${key}=.*$`, "m");
      text = re.test(text) ? text.replace(re, () => line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
      process.env[key] = value;
    }
    writeFileSync(`${envFile}.tmp`, text, { mode: 0o600 });
    renameSync(`${envFile}.tmp`, envFile);
  },
  confirm: async (question) => {
    if (!process.stdin.isTTY) {
      throw new UserError("No terminal to confirm in.", "Pass --yes to publish without a prompt.");
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(question);
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
  },
}).then((code) => process.exit(code));
