import type { R2BucketLike } from "../src/drivers/cloudflare.ts";
import { R2Binding } from "../src/drivers/cloudflare.ts";
import { MultiFS } from "../src/index.ts";

interface Env {
  BUCKET: R2BucketLike;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const fs = new MultiFS(new URL(request.url).pathname, R2Binding(env.BUCKET));

    if (request.method === "PUT") {
      await fs.write("/uploads/payload.bin", await request.blob());
      return new Response("stored", { status: 201 });
    }

    if (request.method === "GET") {
      const blob = await fs.read("/uploads/payload.bin");
      if (!blob) {
        return new Response("not found", { status: 404 });
      }
      return new Response(blob, {
        headers: { "content-type": "application/octet-stream" },
      });
    }

    if (request.method === "DELETE") {
      await fs.delete("/uploads/payload.bin");
      return new Response("deleted");
    }

    const listing = await fs.ls("/");
    return Response.json(Object.keys(listing));
  },
};
