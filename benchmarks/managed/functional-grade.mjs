import { readFile } from "node:fs/promises";
import { join } from "node:path";
const root = process.argv[2];
try {
  if (
    (await readFile(join(root, "root.txt"), "utf8")) !== "root:alpha\n" ||
    (await readFile(join(root, "child.txt"), "utf8")) !== "child:beta\n"
  )
    throw Error("artifact mismatch");
  console.log(JSON.stringify({ pass: true, reason: "exact-two-file-acceptance" }));
} catch {
  console.log(JSON.stringify({ pass: false, reason: "exact-two-file-acceptance" }));
  process.exitCode = 1;
}
