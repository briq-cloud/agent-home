import { readFile } from "node:fs/promises";
import { tasks, grade } from "./fixtures.mjs";
const [dir, id, answerFile] = process.argv.slice(2);
const task = tasks.find((t) => t.id === id);
if (!task) process.exit(2);
process.stdout.write(JSON.stringify(await grade(dir, task, await readFile(answerFile, "utf8"))));
