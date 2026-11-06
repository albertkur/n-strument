// Run by telemetry.test.ts as `node --expose-gc --import <src/index.js> app.js`, with n-strument's config in the
// environment. It produces one traced HTTP round trip, one custom metric and one GC, then shuts telemetry down.
import { metrics } from "@opentelemetry/api";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { createRequire } from "node:module";
import { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { shutdownTelemetry } from "../../src/index.js";


// Loaded through require, the way Koa (and other CJS dependencies) load it in a real app: n-strument registers no
// ESM loader hook, so the http instrumentation patches the module on a CJS require of it, and an ESM `import` of
// node:http that nothing ever requires afterwards stays unpatched.
const http = createRequire(import.meta.url)("node:http") as typeof import("node:http");


const server = http.createServer((req, res) =>
{
    // The test reads this line to see which propagation headers the client side injected.
    console.log(JSON.stringify({ incomingHeaders: req.headers }));
    res.writeHead(200);
    res.end("ok");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

await new Promise<void>((resolve, reject) =>
{
    http.get(`http://127.0.0.1:${port}/hello`, (res) =>
    {
        res.resume();
        res.on("end", resolve);
    }).on("error", reject);
});

metrics.getMeter("smoke").createCounter("smoke.events").add(1);

// Stand-ins for instrumentations this app has no service for (no Postgres, no Kafka): recorded under their meter
// names, so the test can see which of their metrics the non-dev views let through.
const pgMeter = metrics.getMeter("@opentelemetry/instrumentation-pg");
pgMeter.createHistogram("db.client.operation.duration").record(0.01);
pgMeter.createUpDownCounter("db.client.connection.count").add(1, { "db.client.connection.state": "idle" });
metrics.getMeter("@opentelemetry/instrumentation-kafkajs").createCounter("messaging.client.sent.messages").add(1);

// One export ahead of the one at shutdown, so the exporter's own request to the receiver is made while the http
// client metric is still recording: the test checks that request is left out of it.
await (metrics.getMeterProvider() as MeterProvider).forceFlush();

// GC metrics only exist once a collection has actually run, which a run this short may otherwise never trigger.
(globalThis as { gc?(): void; }).gc?.();

// Covers delivery to the asynchronous GC observer, and the 5+ samples runtime-node needs before it reports
// event-loop delay.
await delay(300);

server.closeAllConnections();
await new Promise<void>((resolve) => server.close(() => resolve()));

await shutdownTelemetry();
