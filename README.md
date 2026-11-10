# n-strument

Instrumentation helper library.

A zero-config-code bootstrap for [OpenTelemetry](https://opentelemetry.io/) in Node.js apps: distributed tracing and metrics. Importing it wires up auto-instrumentation and the OTLP exporters for you — there is no API to call. Its main use for metrics is giving your app's own custom metrics (via `@opentelemetry/api`) somewhere to go.

## Installation

```bash
npm install @nivinjoseph/n-strument
# or
yarn add @nivinjoseph/n-strument
```

## Usage

This is primarily a **side-effect-on-import module**: importing it sets up auto-instrumentation and the OTLP exporters. It also exports a single `shutdownTelemetry` function for draining spans and metrics on shutdown (see below). Import it once, as the **very first import** in your application's entry point, before any module you want traced is loaded:

```ts
// main.ts — the FIRST import, before koa/pg/redis/aws-sdk/etc.
import "@nivinjoseph/n-strument";

// ...the rest of your app
import { startServer } from "./server.js";
startServer();
```

Order matters: OpenTelemetry auto-instrumentation patches modules at load time, so anything imported before `n-strument` will not be traced. For a guaranteed-first load you can preload it via Node instead:

```bash
node --import @nivinjoseph/n-strument ./dist/main.js
```

n-strument does not expose an API for creating custom spans or metrics. It sets up the global tracer and meter providers, so use [`@opentelemetry/api`](https://www.npmjs.com/package/@opentelemetry/api) directly for manual instrumentation:

```ts
import { metrics, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("my-service");
const span = tracer.startSpan("do-work");
// ...
span.end();

const meter = metrics.getMeter("my-service");
const processed = meter.createCounter("orders.processed");
processed.add(1, { "order.type": "standard" });   // keep attribute values low-cardinality
```

> ⚠️ Unlike tracers, a meter obtained **before** n-strument has registered the meter provider is a no-op forever — `@opentelemetry/api` has no proxy for metrics. Preload n-strument with `node --import` so it always loads first. Don't name your meter after an OpenTelemetry instrumentation package (e.g. `@opentelemetry/instrumentation-pg`): outside dev, metrics under those names are dropped (see [Metrics](#metrics)).

### Graceful shutdown

Spans are buffered in memory by a `BatchSpanProcessor` and flushed periodically, and metrics are only exported once per interval (60 seconds unless `OTEL_METRIC_EXPORT_INTERVAL` says otherwise). On process exit neither is drained automatically, so the telemetry around a deploy, scale-down, or shutdown — often the ones you most want — can be lost. n-strument does **not** register its own `SIGTERM`/`SIGINT` handlers (that would race with, and prematurely exit out of, your service's shutdown). Instead it exports `shutdownTelemetry`, which you call as the **last** step of your own graceful-shutdown sequence — after you've stopped accepting work and finished in-flight requests, so their spans are captured:

```ts
import { shutdownTelemetry } from "@nivinjoseph/n-strument";

async function onShutdown(): Promise<void>
{
    await server.stop();        // stop accepting traffic, drain in-flight requests
    await db.dispose();         // your other cleanup
    await shutdownTelemetry();  // flush spans + a final metrics export, shut the exporters down, last
}
```

`shutdownTelemetry()` flushes buffered spans, makes one final metrics export, and shuts the exporters down. It is idempotent — repeat calls return the same shutdown — so it's safe to wire into multiple paths. `shutdownTracing()` is kept as a deprecated alias that does the same.

This works with the `node --import` style too: ES modules are singletons, so importing `shutdownTelemetry` from your code returns the same instance that `--import` already loaded, operating on the same providers.

## Configuration

All settings are read through [`@nivinjoseph/n-config`](https://www.npmjs.com/package/@nivinjoseph/n-config)'s `ConfigurationManager` (environment variables / config files).

| Config key                          | Required | Default                                | Purpose                                                              |
| ----------------------------------- | -------- | -------------------------------------- | ------------------------------------------------------------------- |
| `env`                               | **Yes**  | —                                      | App environment. Throws on startup if missing. `"dev"` defaults the trace host to `localhost`. |
| `package_name` (or `package.name`)  | No       | —                                      | Sets the `service.name` resource attribute.                         |
| `package.version`                   | No       | —                                      | Sets the `service.version` resource attribute.                      |
| `otelTraceSamplingRate`             | No       | `1` (100%)                             | Parent-based ratio sampler.                                         |
| `enableXrayTracing`                 | No       | `false`                                | Use the AWS X-Ray ID generator + propagator.                       |
| `otelTraceHost`                     | No       | `localhost` (dev) / `0.0.0.0` (other)  | The OTLP collector, for traces and metrics alike: `host` or `host:port` (e.g. `dirt-lgtm:4319`). The port defaults to `4318`; bracket an IPv6 address (`[::1]:4318`). |

> ⚠️ If `env` is not set, importing the module throws immediately:
> `ApplicationException: Required config 'env' not found`.

Two standard OpenTelemetry environment variables tune metrics. They're read straight from the environment, not through n-config:

| Environment variable                                | Default      | Purpose |
| --------------------------------------------------- | ------------ | ------- |
| `OTEL_METRIC_EXPORT_INTERVAL`                       | `60000`      | How often metrics are pushed, in milliseconds. Also how often gauges are read. A value that isn't a number is ignored with a warning. |
| `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` | `cumulative` | `cumulative` or `delta` (any case). Keep cumulative for Prometheus (e.g. Grafana LGTM), which only stores cumulative and drops delta batches whole. Set `delta` for the Datadog Agent, so no series loses its first point (see [Metrics](#metrics)). |

## Backend / infrastructure

Spans are exported over **OTLP/HTTP** to `http://<host>:<port>/v1/traces`, and metrics to `http://<host>:<port>/v1/metrics`, both taken from `otelTraceHost` (the port defaulting to the standard `4318`). You need an OpenTelemetry Collector — or any OTLP-HTTP-compatible backend (Grafana LGTM, Grafana Tempo, Jaeger, the Datadog Agent, AWS Distro for OpenTelemetry, etc.) — listening on that port (**4318** unless `otelTraceHost` names another). Without one, the app still runs but exports fail in the background. Logs are never exported; write them to stdout for your log pipeline to collect.

The collector must accept both: a trace-only backend such as Jaeger rejects `/v1/metrics`, and n-strument logs an export error every interval.

### Minimal local setup

[Grafana LGTM](https://hub.docker.com/r/grafana/otel-lgtm) is a single container with an OTLP collector feeding Tempo (traces), Prometheus (metrics) and Loki, behind Grafana:

```bash
# configuration (env vars, or however your n-config is wired). n-config also reads ./package.json,
# which supplies package.version (a name with a dot can't be exported from the shell).
export env=dev
export package_name=my-service

# Grafana on :3000 (no login), OTLP on :4318
docker run -p 3000:3000 -p 4318:4318 grafana/otel-lgtm
```

Traces are under **Explore → Tempo** and metrics under **Explore → Prometheus** at <http://localhost:3000>.

## Metrics

n-strument always registers the global meter provider, so your custom metrics (see [Usage](#usage)) are exported, along with metrics from the auto-instrumentations:

- **In dev (`env` is `"dev"`)**, everything the enabled instrumentations record — for local dashboards:
  - Node runtime: event-loop delay, utilization and time (`nodejs.eventloop.*`), GC duration and heap (`v8js.*`)
  - HTTP: `http.server.duration`, `http.client.duration`
  - PostgreSQL: `db.client.operation.duration`, `db.client.connection.count`, `db.client.connection.pending_requests`
  - Kafka: `messaging.*`
  - AWS SDK (Bedrock only): `gen_ai.*`
- **Everywhere else**, only your custom metrics plus these, because a backend like Datadog bills every metric series and already derives most request metrics from traces:
  - `nodejs.eventloop.delay.p99`, `nodejs.eventloop.utilization` — event-loop health
  - `db.client.connection.count`, `db.client.connection.pending_requests` — pg pool saturation
  - `http.server.duration`, tagged only with `http.method`, `http.route` and `http.status_code`. Unlike trace-derived request metrics, it stays correct when `otelTraceSamplingRate` is below 1. With `OTEL_SEMCONV_STABILITY_OPT_IN=http` it's exported under its stable name, `http.server.request.duration`, tagged only with `http.request.method`, `http.route` and `http.response.status_code`. With `http/dup`, both are exported, so every request series is paid for twice.

  Everything else the instrumentations record is dropped, using metric views: every enabled instrumentation other than runtime-node, pg and http is dropped whole, and those three have their other metrics dropped by name — `nonDevDroppedMetrics` in [`src/index.ts`](src/index.ts). Enabling another instrumentation keeps its metrics out automatically, but a metric that an OpenTelemetry upgrade adds to runtime-node, pg or http is exported until it's added to that list.

Metrics are pushed every 60 seconds (`OTEL_METRIC_EXPORT_INTERVAL`) and on `shutdownTelemetry()`. By default they're sent with cumulative temporality (each push carries running totals), which Prometheus (e.g. Grafana LGTM) requires. A counter or histogram series only comes into existence on its first recording, and its first point already holds everything recorded so far, so neither backend shows that first interval: Prometheus's `rate()` and `increase()` need an earlier sample to compare against, so a burst that creates a series shows as flat, though the counter's raw value is correct; and the Datadog Agent, which turns cumulative into deltas itself, drops each new series' first point. That happens for every new combination of attribute values the first time it occurs after a process start, not only once per process. Setting `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta` avoids it in Datadog, since each delta point is complete on its own. Counters and histograms lose nothing between pushes — each push carries everything recorded since the last one — but a gauge is only read at each push, so a value that rises and falls between two pushes isn't seen. On AWS Lambda, the aws-lambda instrumentation also flushes spans and metrics at the end of every invocation, since a frozen function would otherwise never send them, and the invocation doesn't return until that export finishes. So a Lambda that preloads n-strument needs a collector it can reach (an ADOT layer or the Datadog extension): with none, every invocation spends about 8 seconds retrying the export before it returns, which is longer than Lambda's default 3-second timeout, so with default settings every invocation times out.

Series carry no per-process attribute — only `service.name` and `service.version` — so they assume each process reports through its own collector or Agent, such as a Datadog Agent sidecar per task. Processes of one service that share an Agent, or concurrent instances of one Lambda, send the same series, and their cumulative totals collide.

## What gets instrumented

The following auto-instrumentations are enabled. This set is fixed and not configurable without editing the library — but the full list of instrumentations is declared explicitly in `src/index.ts`, so flipping one on or off is a one-line `enabled` change:

- HTTP
- gRPC
- PostgreSQL (`pg`)
- Knex
- Redis (`redis` / node-redis; `ioredis` is disabled)
- Koa (middleware-layer spans are suppressed)
- AMQP / RabbitMQ (`amqplib`)
- Kafka (`kafkajs`)
- Socket.IO
- AWS SDK
- AWS Lambda
- Node runtime (`runtime-node`; metrics only)

Every other instrumentation that `@opentelemetry/auto-instrumentations-node` ships (Express, Hapi, NestJS, MongoDB, MySQL, GraphQL, DNS, `fs`, the logging integrations, etc.) is explicitly disabled.

To change the set, edit the `instrumentationConfig` map in [`src/index.ts`](src/index.ts) — it lists every instrumentation the library knows about with an explicit `enabled` flag, so toggling one is a single `true`/`false` edit. The map is typed `Required<InstrumentationConfigMap>`, which means a future `@opentelemetry/auto-instrumentations-node` upgrade that adds a new instrumentation will fail the build until you add the key and make a deliberate enabled/disabled decision (rather than letting it silently default to on).

## License

MIT
