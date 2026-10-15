import { migrate } from "./db.js";
import { seedDemo } from "./seed.js";
import { evaluateAll } from "./rules.js";
await migrate();
const cmd = process.argv[2];
if (cmd === "seed") console.log(JSON.stringify(seedDemo("cli"), null, 2));
else if (cmd === "evaluate") console.log(JSON.stringify(evaluateAll("cli"), null, 2));
else console.log("usage: cli.ts seed|evaluate");
