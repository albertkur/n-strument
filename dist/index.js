import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { context, diag, DiagConsoleLogger, DiagLogLevel, metrics } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import { KoaLayerType } from "@opentelemetry/instrumentation-koa";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { 
// SemanticResourceAttributes,
ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { NodeTracerProvider, ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AggregationType, createAllowListAttributesProcessor, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { ConfigurationManager } from "@nivinjoseph/n-config";
import { TypeHelper } from "@nivinjoseph/n-util";
import { AWSXRayPropagator } from "@opentelemetry/propagator-aws-xray";
import { AWSXRayIdGenerator } from "@opentelemetry/id-generator-aws-xray";
// For troubleshooting, set the log level to DiagLogLevel.DEBUG
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
// A string config, trimmed, or the fallback when it's unset, blank, or not a string.
function getStringConfig(key, fallback) {
    const value = ConfigurationManager.getConfig(key);
    return typeof value !== "string" || value.isEmptyOrWhiteSpace() ? fallback : value.trim();
}
const env = ConfigurationManager.requireStringConfig("env");
const isDev = env === "dev";
const samplingRate = TypeHelper.parseNumber(ConfigurationManager.getConfig("otelTraceSamplingRate")) ?? 1;
const enableXrayTracing = TypeHelper.parseBoolean(ConfigurationManager.getConfig("enableXrayTracing")) ?? false;
// The OTLP collector, for traces and metrics alike (the key predates both metrics and the port): "host" or
// "host:port", the port defaulting to OTLP/HTTP's 4318. An IPv6 address needs brackets ("[::1]:4318").
const collector = new URL(`http://${getStringConfig("otelTraceHost", isDev ? "localhost" : "0.0.0.0")}`);
const collectorUrl = `http://${collector.hostname}:${collector.port || "4318"}`;
// Every key in the InstrumentationConfigMap is listed explicitly with an `enabled` flag. The
// config object is an *override map*, not an allow-list: any instrumentation left out (or set to
// `undefined`) runs at its own default, which for this library version means ~39 of 40 are on.
// Listing all of them makes the enabled set unambiguous and makes a future library version that
// adds a new instrumentation conspicuous by its absence here, instead of silently turning on.
//
// Enabled: http, grpc, pg, knex, redis, koa, amqplib, kafkajs, socket.io, aws-sdk,
// aws-lambda, and runtime-node (metrics only). Everything else off.
// Entries are kept in the library's own InstrumentationMap order for easy auditing on upgrade.
// `Required<...>` strips the optional modifier off every key, so this literal must list every
// instrumentation the library knows about. When an OTel upgrade adds a new one, the missing key
// becomes a compile error here — forcing a deliberate enabled/disabled decision rather than a
// silent default-on.
const instrumentationConfig = {
    "@opentelemetry/instrumentation-amqplib": { enabled: true },
    "@opentelemetry/instrumentation-aws-lambda": { enabled: true },
    "@opentelemetry/instrumentation-aws-sdk": { enabled: true },
    "@opentelemetry/instrumentation-bunyan": { enabled: false },
    "@opentelemetry/instrumentation-cassandra-driver": { enabled: false },
    "@opentelemetry/instrumentation-connect": { enabled: false },
    "@opentelemetry/instrumentation-cucumber": { enabled: false },
    "@opentelemetry/instrumentation-dataloader": { enabled: false },
    "@opentelemetry/instrumentation-dns": { enabled: false },
    "@opentelemetry/instrumentation-express": { enabled: false },
    "@opentelemetry/instrumentation-fs": { enabled: false },
    "@opentelemetry/instrumentation-generic-pool": { enabled: false },
    "@opentelemetry/instrumentation-graphql": { enabled: false },
    "@opentelemetry/instrumentation-grpc": { enabled: true },
    "@opentelemetry/instrumentation-hapi": { enabled: false },
    "@opentelemetry/instrumentation-host-metrics": { enabled: false },
    "@opentelemetry/instrumentation-http": {
        enabled: true,
        // The OTLP exporters' own requests to the collector. Both exporters send with tracing suppressed, so no
        // span is made, but the client duration metric would still record every export.
        ignoreOutgoingRequestHook: () => isTracingSuppressed(context.active())
    },
    "@opentelemetry/instrumentation-ioredis": { enabled: false }, // we don't want low-level ioredis command spans; the EDA flow is already traced via n-eda's event.* publish/process messaging spans
    "@opentelemetry/instrumentation-kafkajs": { enabled: true },
    "@opentelemetry/instrumentation-knex": { enabled: true },
    "@opentelemetry/instrumentation-koa": { enabled: true, ignoreLayersType: [KoaLayerType.MIDDLEWARE] },
    "@opentelemetry/instrumentation-lru-memoizer": { enabled: false },
    "@opentelemetry/instrumentation-memcached": { enabled: false },
    "@opentelemetry/instrumentation-mongodb": { enabled: false },
    "@opentelemetry/instrumentation-mongoose": { enabled: false },
    "@opentelemetry/instrumentation-mysql2": { enabled: false },
    "@opentelemetry/instrumentation-mysql": { enabled: false },
    "@opentelemetry/instrumentation-nestjs-core": { enabled: false },
    "@opentelemetry/instrumentation-net": { enabled: false },
    "@opentelemetry/instrumentation-openai": { enabled: false },
    "@opentelemetry/instrumentation-oracledb": { enabled: false },
    "@opentelemetry/instrumentation-pg": { enabled: true },
    "@opentelemetry/instrumentation-pino": { enabled: false },
    "@opentelemetry/instrumentation-redis": { enabled: true },
    "@opentelemetry/instrumentation-restify": { enabled: false },
    "@opentelemetry/instrumentation-router": { enabled: false },
    "@opentelemetry/instrumentation-runtime-node": { enabled: true },
    "@opentelemetry/instrumentation-socket.io": { enabled: true },
    "@opentelemetry/instrumentation-tedious": { enabled: false },
    "@opentelemetry/instrumentation-undici": { enabled: false },
    "@opentelemetry/instrumentation-winston": { enabled: false }
};
// Outside dev, the instrumentations' metrics are dropped (custom metrics never are). Datadog derives the rest of
// the request picture from traces, and container CPU/memory are expected from its agent, so only what neither
// covers is kept: event-loop health, pg pool saturation, and request metrics that — unlike trace-derived ones —
// stay correct when otelTraceSamplingRate drops below 1. Those come from the three instrumentations below; every
// other enabled instrumentation is dropped whole. Views can only drop, so for these three the list names what
// to drop, not what to keep — re-check it on an OTel upgrade, since a metric one of them adds is exported until
// it's listed here.
const nonDevDroppedMetrics = {
    // keeps nodejs.eventloop.delay.p99 and nodejs.eventloop.utilization
    "@opentelemetry/instrumentation-runtime-node": [
        "nodejs.eventloop.delay.min", "nodejs.eventloop.delay.max", "nodejs.eventloop.delay.mean",
        "nodejs.eventloop.delay.stddev", "nodejs.eventloop.delay.p50", "nodejs.eventloop.delay.p90",
        "nodejs.eventloop.time", "v8js.*"
    ],
    // keeps db.client.connection.count and db.client.connection.pending_requests
    "@opentelemetry/instrumentation-pg": ["db.client.operation.duration"],
    // keeps http.server.duration, or under OTEL_SEMCONV_STABILITY_OPT_IN=http its stable name
    // http.server.request.duration; the client metric is listed under both names
    "@opentelemetry/instrumentation-http": ["http.client.duration", "http.client.request.duration"]
};
const resource = defaultResource().merge(resourceFromAttributes({
    // [SemanticResourceAttributes.SERVICE_NAME]: ConfigurationManager.getConfig("package.name"),
    // [SemanticResourceAttributes.SERVICE_VERSION]: ConfigurationManager.getConfig("package.version"),
    // [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: env
    [ATTR_SERVICE_NAME]: ConfigurationManager.getConfig("package_name") ?? ConfigurationManager.getConfig("package.name") ?? undefined,
    [ATTR_SERVICE_VERSION]: ConfigurationManager.getConfig("package.version") ?? undefined
}));
const tracerConfig = {
    resource: resource,
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(samplingRate) })
};
if (enableXrayTracing)
    tracerConfig.idGenerator = new AWSXRayIdGenerator();
// const exporter = new ConsoleSpanExporter();
const traceExporter = new OTLPTraceExporter({
    // optional - default url is http://localhost:4318/v1/traces
    url: `${collectorUrl}/v1/traces`,
    // optional - collection of custom headers to be sent with each request, empty by default
    headers: {}
});
// Span processors are now supplied via the constructor (addSpanProcessor was removed in the OTel SDK 2.x line).
const tracerProvider = new NodeTracerProvider({
    ...tracerConfig,
    spanProcessors: [new BatchSpanProcessor(traceExporter)]
});
tracerProvider.register(enableXrayTracing ? { propagator: new AWSXRayPropagator() } : undefined);
// No temporality is set, so the exporter's default applies: cumulative. Prometheus (e.g. Grafana LGTM in dev) only
// stores cumulative, and the Datadog agent accepts it, turning it into deltas itself (it drops the first point after
// each process start, having nothing to subtract it from).
const metricExporter = new OTLPMetricExporter({
    url: `${collectorUrl}/v1/metrics`
});
const views = new Array();
if (!isDev) {
    // A view with only a meter name matches every metric that meter records, and each instrumentation's meter
    // is named after its package — the key it has in instrumentationConfig. Deriving the list from there means
    // enabling another instrumentation keeps its metrics out of prod without touching this.
    for (const [name, config] of Object.entries(instrumentationConfig))
        if (config.enabled === true && !(name in nonDevDroppedMetrics))
            views.push({ meterName: name, aggregation: { type: AggregationType.DROP } });
    for (const [meterName, instrumentNames] of Object.entries(nonDevDroppedMetrics))
        for (const instrumentName of instrumentNames)
            views.push({ meterName, instrumentName, aggregation: { type: AggregationType.DROP } });
    // Keep the request metric's tags to bounded ones; old semconv also tags it with the client-supplied Host
    // header (net.host.name), and Datadog bills every tag combination. Same tags under the stable names.
    views.push({
        meterName: "@opentelemetry/instrumentation-http",
        instrumentName: "http.server.duration",
        attributesProcessors: [createAllowListAttributesProcessor(["http.method", "http.route", "http.status_code"])]
    }, {
        meterName: "@opentelemetry/instrumentation-http",
        instrumentName: "http.server.request.duration",
        attributesProcessors: [
            createAllowListAttributesProcessor(["http.request.method", "http.route", "http.response.status_code"])
        ]
    });
}
const meterProvider = new MeterProvider({
    resource,
    views,
    // The SDK's default interval: a push every 60s. Counters and histograms lose nothing between pushes; a gauge is
    // read only at each push.
    readers: [new PeriodicExportingMetricReader({ exporter: metricExporter })]
});
// @opentelemetry/api has no proxy for metrics: a meter obtained before a provider is registered stays a no-op
// forever. Registering here, at preload and ahead of any app code, is what lets app and library code (e.g.
// n-eda) record custom metrics through metrics.getMeter(...).
metrics.setGlobalMeterProvider(meterProvider);
// This registers all instrumentation packages. Both providers are passed explicitly, after they exist: the
// aws-lambda instrumentation decides how to flush spans at the end of an invocation once, when it is handed its
// tracer provider, and handed the global proxy before a real provider was registered it never flushes at all.
registerInstrumentations({
    instrumentations: [
        getNodeAutoInstrumentations(instrumentationConfig)
    ],
    tracerProvider,
    meterProvider
});
// The BatchSpanProcessor buffers finished spans in memory and only flushes periodically (or once a
// batch fills), and the PeriodicExportingMetricReader likewise only exports on its interval; their
// timers are unref'd, so the process can exit with spans and metrics still unsent, and neither
// provider registers exit handlers of its own. Rather than have this library grab SIGTERM/SIGINT —
// which would race with, and process.exit() out of, the host service's own graceful-shutdown
// sequence — we export a drain function for the host to invoke as part of its shutdown. Each
// provider's shutdown() flushes what it holds (the meter provider with one final export) and shuts
// its exporter down.
let shutdownPromise = null;
/**
 * Flushes any buffered spans and metrics and shuts the exporters down.
 *
 * Call this from your service's graceful-shutdown sequence — after it has stopped accepting work
 * and finished in-flight requests, so their spans are captured — to avoid losing the spans the
 * BatchSpanProcessor is still holding in memory and the metrics recorded since the last export.
 * Safe to call more than once: repeat calls return the same in-flight (or completed) shutdown.
 */
export function shutdownTelemetry() {
    if (shutdownPromise != null)
        return shutdownPromise;
    shutdownPromise = Promise.all([
        tracerProvider.shutdown().catch((e) => {
            diag.error("Error shutting down tracer provider", e);
        }),
        meterProvider.shutdown().catch((e) => {
            diag.error("Error shutting down meter provider", e);
        })
    ]).then(() => { });
    return shutdownPromise;
}
/**
 * Flushes any buffered spans and metrics and shuts the exporters down.
 *
 * @deprecated Use {@link shutdownTelemetry}; this alias does the same, metrics included.
 */
export function shutdownTracing() {
    return shutdownTelemetry();
}
//# sourceMappingURL=index.js.map