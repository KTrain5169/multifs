import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      build: "vp pack",
      dev: {
        command: "vp pack --watch",
        cache: false,
      },
      test: "vp test",
      check: "vp check",
    },
  },
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    entry: {
      index: "src/index.ts",
      types: "src/types.ts",
      "drivers/cloudflare": "src/drivers/cloudflare.ts",
      "drivers/aws": "src/drivers/aws.ts",
      "drivers/node": "src/drivers/node.ts",
      "drivers/memory": "src/drivers/memory.ts",
      "drivers/netlify": "src/drivers/netlify.ts",
      "drivers/vercel": "src/drivers/vercel.ts",
    },
    dts: {
      tsgo: true,
    },
    exports: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
