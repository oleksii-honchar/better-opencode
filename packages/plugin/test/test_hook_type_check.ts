import type { Hooks } from "../src/index.js"

// This should error if the key is NOT on the Hooks interface
const hooks: Hooks = {}
const hookFn = hooks["experimental.tools.transform"]
