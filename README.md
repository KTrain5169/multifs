# `multifs`

A unified interface for interacting with file"system"s.

Initial release plans on working with `node:fs`, `memfs`, Cloudflare R2 (Bindings & HTTP), AWS S3, Netlify Blobs, Vercel Blob.

## Usage

Install the library from npm:

```
npm install multifs
yarn add multifs
pnpm install multifs
# see more install commands at https://npmx.dev/package/multifs
```

Import drivers from the `multifs/drivers/*` subpath:

```ts
import { MultiFS } from "multifs";
import { node } from "multifs/drivers/node";

const fs = new MultiFS(node());
```

Then, use them like you want!

## Credits

This package was heavily inspired by [`unjs/unstorage`](https://github.com/unjs/unstorage), some of which is reflected in the API shape of the package.
