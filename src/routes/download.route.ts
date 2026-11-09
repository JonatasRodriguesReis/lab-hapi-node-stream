import { Readable, Stream } from "node:stream";
import type { Request, Server } from "@hapi/hapi";
import { destroyStream, streamToBuffer } from "../services/stream.service.js";
import {
  createJsZipStream,
  diagnoseZip,
  generateZip,
} from "../services/zip.service.js";

export const sampleData = {
  title: "lab-stream-zip",
  items: [
    { id: 1, name: "alpha" },
    { id: 2, name: "beta" },
  ],
};

const ZIP_TYPE = "application/zip";
const ZIP_DISPOSITION = 'attachment; filename="data.zip"';

export function registerDownloadRoutes(server: Server): void {
  server.route({
    method: "GET",
    path: "/download/stream.zip",
    handler(request, h) {
      const zipStream = generateZip(sampleData);
      console.log("Zip stream created");
      destroyWhenClientDisconnects(request, zipStream);

      zipStream.on("error", (error: Error) => {
        console.error(
          JSON.stringify({
            event: "zip-stream-error",
            message: error.message,
          }),
        );
      });

      console.log("Zip stream returned");
      return h
        .response(zipStream)
        .type(ZIP_TYPE)
        .header("Content-Disposition", ZIP_DISPOSITION);
    },
  });

  server.route({
    method: "GET",
    path: "/download/buffer.zip",
    async handler(request, h) {
      const zipStream = generateZip(sampleData);
      destroyWhenClientDisconnects(request, zipStream);

      try {
        const payload = await streamToBuffer(zipStream);
        console.info(
          JSON.stringify({
            event: "zip-buffered",
            bytes: payload.length,
          }),
        );

        return h
          .response(payload)
          .type(ZIP_TYPE)
          .header("Content-Disposition", ZIP_DISPOSITION);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "zip-buffer-error",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        throw error;
      }
    },
  });

  server.route({
    method: "GET",
    path: "/download/raw.zip",
    handler(_request, h) {
      return h
        .response(createJsZipStream(sampleData))
        .type(ZIP_TYPE)
        .header("Content-Disposition", ZIP_DISPOSITION);
    },
  });

  server.route({
    method: "GET",
    path: "/download/stream-error",
    handler(_request, h) {
      const failing = new Readable({
        read() {
          process.nextTick(() => {
            this.destroy(new Error("forced ZIP stream failure"));
          });
        },
      });

      failing.on("error", (error: Error) => {
        console.error(
          JSON.stringify({
            event: "forced-stream-error",
            message: error.message,
          }),
        );
      });

      return h
        .response(failing)
        .type(ZIP_TYPE)
        .header("Content-Disposition", ZIP_DISPOSITION);
    },
  });

  server.route({
    method: "GET",
    path: "/download/buffer-error",
    async handler() {
      const failing = new Readable({
        read() {
          process.nextTick(() => {
            this.destroy(new Error("forced ZIP stream failure"));
          });
        },
      });

      await streamToBuffer(failing);
      throw new Error("buffer conversion should have failed");
    },
  });

  server.route({
    method: "GET",
    path: "/download/open",
    handler(request, h) {
      let started = false;
      const open = new Readable({
        read() {
          if (started) {
            return;
          }

          started = true;
          setTimeout(() => {
            if (this.destroyed) {
              return;
            }

            this.push(Buffer.from("still-open"));
            this.push(null);
          }, 2000);
        },
      });

      destroyWhenClientDisconnects(request, open);
      return h.response(open).type("application/octet-stream");
    },
  });

  server.route({
    method: "GET",
    path: "/diagnostics",
    async handler() {
      const streams = diagnoseZip(sampleData);
      const once = generateZip(sampleData);
      const first = await streamToBuffer(once);

      let secondBytes: number | null = null;
      let secondError: string | null = null;

      try {
        const second = await streamToBuffer(once);
        secondBytes = second.length;
      } catch (error) {
        secondError = error instanceof Error ? error.message : String(error);
      }

      return {
        streams,
        consumption: {
          firstBytes: first.length,
          secondBytes,
          secondError,
        },
        summary:
          "JSZip returns a readable-stream v2 object. generateZip() pipes it through a Node.js PassThrough and declares that result as Stream. Buffer conversion reads that Stream to completion and retains the archive.",
      };
    },
  });
}

function destroyWhenClientDisconnects(
  request: Request,
  zipStream: Stream,
): void {
  let cancelled = false;

  const cancel = () => {
    if (cancelled) {
      return;
    }

    cancelled = true;
    console.info(JSON.stringify({ event: "client-disconnect" }));
    destroyStream(zipStream);
  };

  // `aborted` fires when the client drops the socket before the response
  // finishes. Hapi emits `disconnect` for that same request abort.
  // A completed response does not emit either event.
  request.events.on("disconnect", cancel);
  request.raw.req.on("aborted", cancel);
}
