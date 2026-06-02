import { pathToFileURL } from "node:url";
import { type BuildServerOptions, buildServer } from "./build-server.js";

export { buildServer, type BuildServerOptions };

// Runtime entrypoint: boot the REST server only when this file is executed
// directly (`node dist/server.js`), not when imported as a library. Comparing
// `import.meta.url` against `pathToFileURL(argv[1])` is robust to relative vs
// absolute invocation paths.
const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1] as string).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  const app = buildServer();
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
