import { Server } from "@hapi/hapi";
import { registerDownloadRoutes } from "./routes/download.route.js";

const REQUIRED_NODE = "24.22.1";

if (process.version !== `v${REQUIRED_NODE}`) {
  console.warn(
    `This lab was verified on Node.js v${REQUIRED_NODE}. Current runtime is ${process.version}.`,
  );
}

const port = Number(process.env.PORT ?? 8000);
const host = process.env.HOST ?? "127.0.0.1";

const server = new Server({ host, port });
registerDownloadRoutes(server);

await server.start();
console.log(`listening on ${server.info.uri}`);

process.once("SIGINT", () => {
  server.stop({ timeout: 1000 }).finally(() => {
    process.exit(0);
  });
});
