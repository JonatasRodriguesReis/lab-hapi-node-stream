import {
  PassThrough,
  Readable,
  Stream,
  Transform,
  Writable,
} from "node:stream";
import { pipeline } from "node:stream/promises";

export interface StreamDiagnostics {
  constructorName: string;
  prototypeChain: string[];
  instanceofNodeStream: boolean;
  instanceofNodeReadable: boolean;
  readableObjectMode: boolean | null;
  hasPipe: boolean;
  hasRead: boolean;
  hasDestroy: boolean;
  hasAsyncIterator: boolean;
  /**
   * Hapi 21 accepts a response stream only when it is a Node.js Readable
   * and `readableObjectMode` is not true. See `@hapi/hapi/lib/streams.js`.
   */
  hapiAcceptsAsByteStream: boolean;
}

/**
 * Pipe JSZip's readable-stream v2 object into a Node.js PassThrough.
 *
 * `generateNodeStream()` is typed as `NodeJS.ReadableStream` and, at runtime,
 * is a `readable-stream@2` Readable. That object extends Node's `Stream` base
 * class, but it is not `instanceof Readable`, and it has no async iterator.
 * Hapi 21 rejects it. `Readable.from()` also rejects it because it is not iterable.
 *
 * `PassThrough` is a real Node.js Readable, so it satisfies the declared
 * `Stream` return type without a cast. `pipeline` forwards errors and destroys
 * the JSZip stream when the consumer stops. The tap logs each chunk on the way
 * through and writes the same bytes onward.
 */
export function adaptToNodeStream(source: NodeJS.ReadableStream): Stream {
  const output = new PassThrough();
  /* const tap = new Transform({
    transform(chunk: unknown, _encoding, callback) {
      console.info(
        JSON.stringify({
          event: "zip-chunk",
          bytes: chunkByteLength(chunk),
        }),
      );
      callback(null, chunk);
    },
  }); */

  pipeline(source, output).catch((error: unknown) => {
    const failure =
      error instanceof Error ? error : new Error("ZIP stream failed");
    /* logger.error({
      event: "zip-pipeline-error",
      message: failure.message,
      code: "code" in failure ? failure.code : undefined,
    }); */
    if (output.destroyed || output.readableEnded) {
      return;
    }
    output.destroy(failure);
  });

  return output;
}

/**
 * Same adapter as `adaptToNodeStream`, built from a Writable and a Readable.
 * `pipeline` writes JSZip chunks into `input`. `input.write` pushes each chunk
 * to `output` and waits while `output` is full. Callers read `output`.
 */
export function adaptToNodeStreamManual(source: NodeJS.ReadableStream): Stream {
  let release: (() => void) | null = null;

  const output = new Readable({
    read() {
      const pending = release;
      release = null;
      pending?.();
    },
  });

  const input = new Writable({
    write(chunk: unknown, _encoding, callback) {
      console.info(
        JSON.stringify({
          event: "zip-chunk",
          bytes: chunkByteLength(chunk),
        }),
      );

      let buffer: Buffer;
      try {
        buffer = toBuffer(chunk);
      } catch (error) {
        callback(
          error instanceof Error ? error : new Error("ZIP stream failed"),
        );
        return;
      }

      if (output.destroyed) {
        callback(new Error("ZIP stream closed"));
        return;
      }

      const hasRoom = output.push(buffer);
      if (hasRoom) {
        callback();
        return;
      }

      release = callback;
    },
    final(callback) {
      if (!output.destroyed && !output.readableEnded) {
        output.push(null);
      }
      callback();
    },
  });

  output.on("close", () => {
    if (!input.destroyed) {
      input.destroy();
    }
  });

  pipeline(source, input)
    .then(() => {
      console.log("Pipeline completed");
    })
    .catch((error: unknown) => {
      if (output.destroyed || output.readableEnded) {
        return;
      }

      const failure =
        error instanceof Error ? error : new Error("ZIP stream failed");
      output.destroy(failure);
    });

  return output;
}

export function describeStream(stream: object): StreamDiagnostics {
  const readableObjectMode = readObjectMode(stream);
  const instanceofNodeReadable = stream instanceof Readable;

  return {
    constructorName: constructorName(stream),
    prototypeChain: prototypeChain(stream),
    instanceofNodeStream: stream instanceof Stream,
    instanceofNodeReadable,
    readableObjectMode,
    hasPipe: typeof Reflect.get(stream, "pipe") === "function",
    hasRead: typeof Reflect.get(stream, "read") === "function",
    hasDestroy: typeof Reflect.get(stream, "destroy") === "function",
    hasAsyncIterator:
      typeof Reflect.get(stream, Symbol.asyncIterator) === "function",
    hapiAcceptsAsByteStream:
      instanceofNodeReadable && readableObjectMode !== true,
  };
}

/**
 * Read the Stream once and keep every chunk. The source cannot be read again.
 */
export async function streamToBuffer(source: Stream): Promise<Buffer> {
  if (!(source instanceof Readable)) {
    throw new TypeError(
      "Expected a Node.js Readable. Declaring the value as Stream does not make it one at runtime.",
    );
  }

  const chunks: Buffer[] = [];

  for await (const chunk of source) {
    chunks.push(toBuffer(chunk));
  }

  return Buffer.concat(chunks);
}

export function destroyStream(source: Stream): void {
  if (source instanceof Readable) {
    source.destroy();
    return;
  }

  const destroy = Reflect.get(source, "destroy");
  if (typeof destroy === "function") {
    destroy.call(source);
  }
}

function chunkByteLength(chunk: unknown): number {
  if (Buffer.isBuffer(chunk) || typeof chunk === "string") {
    return Buffer.byteLength(chunk);
  }

  if (chunk instanceof Uint8Array) {
    return chunk.byteLength;
  }

  return 0;
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (typeof chunk === "string" || chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }

  throw new TypeError("ZIP stream emitted a non-binary chunk");
}

function constructorName(value: object): string {
  const constructor = Reflect.get(value, "constructor");
  if (typeof constructor === "function" && constructor.name) {
    return constructor.name;
  }

  return "unknown";
}

function prototypeChain(value: object): string[] {
  const names: string[] = [];
  const seen = new Set<object>();
  let current: object | null = value;

  while (current && !seen.has(current)) {
    seen.add(current);
    names.push(constructorName(current));
    const parent: unknown = Object.getPrototypeOf(current);
    current = isObject(parent) ? parent : null;
  }

  return names;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function readObjectMode(stream: object): boolean | null {
  const mode = Reflect.get(stream, "readableObjectMode");
  return typeof mode === "boolean" ? mode : null;
}
