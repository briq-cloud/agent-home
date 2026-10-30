import { gradeManaged } from "./fixtures.mjs";
const [root, id, rawSeed] = process.argv.slice(2);
const result = await gradeManaged(root, id, Number(rawSeed));
console.log(JSON.stringify(result));
if (!result.pass) process.exitCode = 1;
