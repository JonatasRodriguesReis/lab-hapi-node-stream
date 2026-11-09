import { Stream, Readable } from "node:stream";
import JSZip from "jszip";
import {
  adaptToNodeStream,
  adaptToNodeStreamManual,
  describeStream,
  type StreamDiagnostics,
} from "./stream.service.js";

export interface ZipStreamReport {
  source: StreamDiagnostics;
  output: StreamDiagnostics;
}

export function generateZip(data: object): Stream {
  const source = createJsZipStream(data);
  const sourceReport = describeStream(source);
  const output = adaptToNodeStreamManual(source);

  console.info(
    JSON.stringify({
      event: "generateZip",
      source: sourceReport,
      output: describeStream(output),
    }),
  );

  return output;
}

/**
 * The object JSZip actually returns. Successful downloads do not send this
 * object to Hapi; `generateZip()` adapts it first.
 */
export function createJsZipStream(data: object): NodeJS.ReadableStream {
  const zip = new JSZip();
  zip.file("data.json", JSON.stringify(data));

  return zip.generateNodeStream({
    type: "nodebuffer",
    streamFiles: true,
  });
}

export function diagnoseZip(data: object): ZipStreamReport {
  const source = createJsZipStream(data);
  const sourceReport = describeStream(source);
  source.on("error", () => undefined);
  destroyIfPossible(source);

  const output = generateZip(data);
  const outputReport = describeStream(output);
  output.on("error", () => undefined);
  destroyIfPossible(output);

  return {
    source: sourceReport,
    output: outputReport,
  };
}

function destroyIfPossible(stream: object): void {
  const destroy = Reflect.get(stream, "destroy");
  if (typeof destroy === "function") {
    destroy.call(stream);
  }
}
