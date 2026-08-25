import { createMemoryFs, createNodeFs } from "./helpers.ts";
import { runLocalDriverSuite } from "./suite-local.ts";

runLocalDriverSuite("node", createNodeFs);
runLocalDriverSuite("memory", createMemoryFs);
