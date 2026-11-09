# lab-stream-zip

A small Hapi server that builds the same ZIP twice from one function:

- `GET /download/stream.zip` sends the Node.js stream Hapi can pipe to the socket.
- `GET /download/buffer.zip` reads that stream to the end, keeps the bytes in one `Buffer`, then responds.

`generateZip()` is declared as returning `Stream`. Both downloads call that function. ZIP bytes come from JSZip `generateNodeStream()`, not `generateAsync()`.

## Versions

Checked against the npm registry and this machine:

| Package | Version | Why this one |
| --- | --- | --- |
| Node.js | 24.22.1 | Requested runtime. Installed here through nvm. |
| `@hapi/hapi` | 21.4.13 | Latest 21.x. `engines.node` is `>=14.15.0`. |
| `jszip` | 3.10.2 | Latest 3.x. Ships its own `index.d.ts`. |
| `readable-stream` | 2.3.8 | Transitive dependency of JSZip. This is the stream JSZip actually constructs. |
| `typescript` | 5.9.3 | Latest 5.x. TypeScript 7.0.2 is also on npm (`engines.node >= 16.20.0`); this project pins 5.9.3. |
| `@types/node` | 24.19.2 | Latest definitions for Node 24. |

`.nvmrc` is `24.22.1`.

## Install

```bash
nvm use
node --version   # v24.22.1
npm install
```

## Run

```bash
npm run build
npm start
```

The process listens on `127.0.0.1:3000`. If that port is already taken:

```bash
PORT=3010 npm start
```

On this machine port 3000 was already in use, so the checks below were run with `PORT=3010`.

Startup prints a warning when `process.version` is not `v24.22.1`.

## Endpoints

| Method and path | What it does |
| --- | --- |
| `GET /download/stream.zip` | `generateZip()`, then Hapi pipes that stream. `Transfer-Encoding: chunked`. |
| `GET /download/buffer.zip` | Same `generateZip()`, then `streamToBuffer()`. `Content-Length` is the archive size. |
| `GET /diagnostics` | Reports the JSZip stream and the adapted stream, then reads one ZIP stream twice. |
| `GET /download/raw.zip` | Sends JSZip's object to Hapi with no adapter. Hapi responds 500. |
| `GET /download/stream-error` | A Node.js `Readable` that fails on read. |
| `GET /download/buffer-error` | The same failure, consumed with `streamToBuffer()` before the response starts. |
| `GET /download/open` | Stays open for 2 seconds, then writes `still-open`. Used to cancel a live response. |

Both ZIP downloads set:

```http
Content-Type: application/zip
Content-Disposition: attachment; filename="data.zip"
```

`data.json` inside the archive is:

```json
{"title":"lab-stream-zip","items":[{"id":1,"name":"alpha"},{"id":2,"name":"beta"}]}
```

## Download and inspect

```bash
curl -v http://127.0.0.1:3000/download/stream.zip -o stream.zip
curl -v http://127.0.0.1:3000/download/buffer.zip -o buffer.zip

python3 - << 'PY'
import json, zipfile
expected = {
    "title": "lab-stream-zip",
    "items": [{"id": 1, "name": "alpha"}, {"id": 2, "name": "beta"}],
}
for name in ("stream.zip", "buffer.zip"):
    with zipfile.ZipFile(name) as archive:
        assert archive.testzip() is None
        assert json.loads(archive.read("data.json")) == expected
        print(name, "ok", archive.namelist())
PY
```

`unzip -l stream.zip` and `unzip -p stream.zip data.json` show the same file if `unzip` is installed.

Observed on Node 24.22.1:

- Stream response: `200`, `content-type: application/zip`, `content-disposition: attachment; filename="data.zip"`, `Transfer-Encoding: chunked`, no `Content-Length`.
- Buffer response: the same type and disposition, plus `content-length: 215` and `accept-ranges: bytes`.
- Both archives passed `ZipFile.testzip()` and contained that `data.json`.

There is no HTML page. A browser download uses those two headers: `attachment` asks the browser to save the body as `data.zip`.

## Buffer and stream

`GET /download/buffer.zip` calls `streamToBuffer()`, which does `for await` of the stream and `Buffer.concat`. That reads the stream to completion and keeps the whole archive in one contiguous `Buffer` until Hapi writes the response. Hapi sees a `Buffer`, so the variety is `buffer` and it can send `Content-Length`.

`GET /download/stream.zip` returns the stream from `generateZip()` without concatenating it. Hapi's variety is `stream`: it writes the status line and pipes chunks to the socket. Backpressure is the stream high water mark (64 KiB by default on this Node), not the size of the archive.

This sample ZIP is 215 bytes, so it fits in one stream buffer and a process-memory chart will not show a useful gap. The lifecycle is still different. The buffer route cannot start the body until every ZIP byte exists in the heap. The stream route can flush chunks as JSZip produces them. For a large archive the buffer route holds the full file plus JSZip's working memory. The stream route holds the current chunk window.

A finished stream is not a ZIP factory. `/diagnostics` reads the same object twice. The first read returns the archive (215 bytes here). The second read returns an empty `Buffer` and does not throw. The stream is already ended, so iteration finishes with no chunks. Call `generateZip()` again for another download.

## What JSZip returns

`generateNodeStream({ type: 'nodebuffer', streamFiles: true })` is typed as `NodeJS.ReadableStream`.

At runtime the object is `NodejsStreamOutputAdapter` from JSZip, and its prototype is `readable-stream@2.3.8`'s `Readable`. JSZip's `inherits()` replaces the prototype and does not set `constructor`, so `constructor.name` is `Readable` even though the allocating function is the adapter.

Measured on the object JSZip returns:

| Check | Result |
| --- | --- |
| `constructor.name` | `Readable` |
| `instanceof stream.Stream` | `true` |
| `instanceof stream.Readable` | `false` |
| `instanceof` the `readable-stream` `Readable` | `true` |
| `pipe`, `read`, `destroy` | all functions |
| `Symbol.asyncIterator` | missing |
| `readableObjectMode` | `undefined` |

`instanceof` walks one prototype chain and compares it with one constructor function. A second copy of `Readable` from `readable-stream` is a different function, so it fails `instanceof require('stream').Readable` even when the method names match. It can still inherit Node's old `Stream` base class, which is why `instanceof Stream` is true and is not enough. `constructor.name` is also the wrong signal here, because the helper never restored `constructor`.

`Stream`, `Readable`, and `NodeJS.ReadableStream` are not three names for one type:

- `Stream` in `node:stream` is a class. On these `@types/node` definitions it has `pipe` and `compose`.
- `Readable` extends `Stream` and is the class Hapi checks with `instanceof`.
- `NodeJS.ReadableStream` is an older interface: `read`, `pipe`, `pause`, an async iterator, and no `compose`. JSZip's declaration returns that interface.

Returning the JSZip value from `function generateZip(data: object): Stream` is a compile error:

```text
error TS2741: Property 'compose' is missing in type 'ReadableStream' but required in type 'Stream'.
```

`as Stream` or `as Readable` would only change the type the compiler tracks. The value at runtime would still be the `readable-stream` object. Hapi would still reject it.

## Why the adapter is a PassThrough

Hapi 21 treats a response as a stream only when `Streams.isStream` says so (`@hapi/hapi/lib/streams.js`):

1. `stream instanceof require('stream').Readable` must be true.
2. If that is false and `pipe` is a function, Hapi throws `Cannot reply with a stream-like object that is not an instance of Stream.Readable`.
3. If `readableObjectMode` is true, Hapi throws as well.

`GET /download/raw.zip` returns the JSZip object directly. The response is HTTP 500, and the server log contains that `Stream.Readable` error. The public JSON body is Hapi's generic 500 message.

`Readable.from()` is the usual way to get a real Node `Readable` from an iterable. It is the wrong tool here. JSZip's stream has no async iterator (`readable-stream` 2 predates that), and Node throws:

```text
The "iterable" argument must be an instance of Iterable. Received an instance of Readable
```

`Readable.from()` also defaults to `objectMode: true`, which Hapi rejects even when the input is iterable.

`generateZip()` pipes the JSZip object into a `PassThrough` with `stream.promises.pipeline`:

- `PassThrough` is a Node.js `Readable`, so it is a `Stream` without a cast.
- `readableObjectMode` is false, so Hapi accepts it.
- `pipeline` forwards a failure to the output. If the consumer destroys the output, `pipeline` stops the JSZip side.
- The promise rejection is caught so a failure that is already on the stream does not become an unhandled rejection.

The adapted stream reports `instanceof stream.Readable === true`, `hasAsyncIterator === true`, and `hapiAcceptsAsByteStream === true`. Each `generateZip()` call prints both reports as one JSON line.

## Errors and cancellation

`GET /download/buffer-error` fails while the handler is still awaiting the buffer. Hapi returns `500` and `{"statusCode":500,"error":"Internal Server Error","message":"An internal server error occurred"}`. No ZIP body is sent. The server keeps running.

`GET /download/stream-error` fails after Hapi has started the response. Hapi writes the response, then destroys the socket when the stream errors. `curl` exits 52 (`Empty reply from server`). The process logs `forced ZIP stream failure` and the next download still returns 200. A status code cannot be changed once the stream response has started.

Client cancellation uses the request `aborted` event and Hapi's `disconnect` event. On either one the route calls `destroy()` on the stream it handed back. A normal download of this 215-byte ZIP usually finishes before the client socket closes, so those events do not fire and the log stays quiet.

`GET /download/open` keeps a `Readable` open for 2 seconds. Drop the socket before that write:

```bash
node --input-type=module << 'JS'
import http from 'node:http';
const req = http.get('http://127.0.0.1:3000/download/open');
setTimeout(() => req.destroy(), 200);
req.on('error', (error) => console.log(error.code));
JS
```

The client sees `ECONNRESET`. The server logs `{"event":"client-disconnect"}` and destroys the readable so the delayed write does not continue.

Piping alone does not do that cleanup. A direct Node HTTP probe that piped an open `PassThrough` and then destroyed the client got `req` `aborted` with `writableFinished: false`, while both the source and the `PassThrough` stayed open (`sourceDestroyed: false`). Something in the handler has to call `destroy()`.
