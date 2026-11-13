import { getNodeAutoInstrumentations, InstrumentationConfigMap } from "@opentelemetry/auto-instrumentations-node";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { context, diag, DiagConsoleLogger, DiagLogLevel, metrics, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import
{
    CompositePropagator, getNumberFromEnv, isTracingSuppressed, W3CBaggagePropagator, W3CTraceContextPropagator
} from "@opentelemetry/core";
import { KoaLayerType } from "@opentelemetry/instrumentation-koa";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import
{
    // SemanticResourceAttributes,
    ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION
} from "@opentelemetry/semantic-conventions";
import
{
    BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, TracerProvider, TracerProviderOptions
} from "@opentelemetry/sdk-trace";
import
{
    AggregationType, createAllowListAttributesProcessor, MeterProvider, PeriodicExportingMetricReader, ViewOptions
} from "@opentelemetry/sdk-metrics";

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { ConfigurationManager } from "@nivinjoseph/n-config";
import { TypeHelper } from "@nivinjoseph/n-util";
import { AWSXRayPropagator } from "@opentelemetry/propagator-aws-xray";
import { AWSXRayIdGenerator } from "@opentelemetry/id-generator-aws-xray";

// For troubleshooting, set the log level to DiagLogLevel.DEBUG
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);


// A string config, trimmed, or the fallback when it's unset, blank, or not a string.
function getStringConfig(key: string, fallback: string): string
{
    const value = ConfigurationManager.getConfig<string | null>(key);
    return typeof value !== "string" || value.isEmptyOrWhiteSpace() ? fallback : value.trim();
}

const env = ConfigurationManager.requireStringConfig("env");
const isDev = env === "dev";

const samplingRate = TypeHelper.parseNumber(ConfigurationManager.getConfig("otelTraceSamplingRate")) ?? 1;

const enableXrayTracing = TypeHelper.parseBoolean(ConfigurationManager.getConfig("enableXrayTracing")) ?? false;

// The OTLP collector, for traces and metrics alike (the key predates both metrics and the port): "host" or
// "host:port", the port defaulting to OTLP/HTTP's 4318. An IPv6 address needs brackets ("[::1]:4318"). Parsed under
// a scheme of its own, since http's would blank an explicit ":80" as its default.
const collector = new URL(`otlp://${getStringConfig("otelTraceHost", isDev ? "localhost" : "0.0.0.0")}`);
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
const instrumentationConfig: Required<InstrumentationConfigMap> = {
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
        // Every request made with tracing suppressed: in practice the OTLP exporters' own requests to the collector,
        // plus anything app code wraps in suppressTracing. Both exporters send with tracing suppressed, so no span is
        // made, but the client duration metric would still record every export.
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
const nonDevDroppedMetrics: Readonly<Partial<Record<keyof InstrumentationConfigMap, ReadonlyArray<string>>>> = {
    // keeps nodejs.eventloop.delay.p99 and nodejs.eventloop.utilization
    "@opentelemetry/instrumentation-runtime-node": [
        "nodejs.eventloop.delay.min", "nodejs.eventloop.delay.max", "nodejs.eventloop.delay.mean",
        "nodejs.eventloop.delay.stddev", "nodejs.eventloop.delay.p50", "nodejs.eventloop.delay.p90",
        "nodejs.eventloop.time", "v8js.*"
    ],
    // keeps db.client.connection.count, db.client.connection.max and db.client.connection.pending_requests
    "@opentelemetry/instrumentation-pg": ["db.client.operation.duration"],
    // keeps http.server.request.duration
    "@opentelemetry/instrumentation-http": ["http.client.request.duration"]
};


const resource =
    defaultResource().merge(
        resourceFromAttributes({
            // [SemanticResourceAttributes.SERVICE_NAME]: ConfigurationManager.getConfig("package.name"),
            // [SemanticResourceAttributes.SERVICE_VERSION]: ConfigurationManager.getConfig("package.version"),
            // [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: env

            [ATTR_SERVICE_NAME]: ConfigurationManager.getConfig("package_name") ?? ConfigurationManager.getConfig("package.name") ?? undefined,
            [ATTR_SERVICE_VERSION]: ConfigurationManager.getConfig("package.version") ?? undefined
        })
    );

const tracerConfig: TracerProviderOptions = {
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
// The SDK no longer reads the OTEL_BSP_* env vars, so the batch processor runs on its defaults: a 5s delay, batches of
// 512 and a queue of 2048.
const tracerProvider = new TracerProvider({
    ...tracerConfig,
    spanProcessors: [new BatchSpanProcessor({ exporter: traceExporter })]
});

// What NodeTracerProvider.register() did before SDK 3.x removed it: make the provider global, track the active span
// across async calls (without a context manager, spans started in a callback or after an await lose their parent),
// and set the propagator — X-Ray's when enabled, else register()'s default of W3C trace context plus baggage.
trace.setGlobalTracerProvider(tracerProvider);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(enableXrayTracing
    ? new AWSXRayPropagator()
    : new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }));

// Milliseconds from a standard OTel env var, or undefined (with a warning) when it isn't a positive number Node can
// hold as a timer: past 2^31-1, setInterval fires every millisecond instead. getNumberFromEnv already warns about
// and leaves out a value that isn't a number.
function getMillisFromEnv(key: string): number | undefined
{
    const value = getNumberFromEnv(key);
    if (value == null || (value > 0 && value <= 2_147_483_647))
        return value;

    diag.warn(`${key} (${value}) is invalid, expected milliseconds from 1 to 2147483647, using default.`);
    return undefined;
}

// How often metrics are pushed, in milliseconds: the standard OTEL_METRIC_EXPORT_INTERVAL, which the SDK's reader
// doesn't read on its own (only NodeSDK does), else its 60s default.
const metricsExportIntervalMs = getMillisFromEnv("OTEL_METRIC_EXPORT_INTERVAL") ?? 60_000;

// No temporality is set here, so the exporter reads the standard OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE
// itself, defaulting to cumulative. Prometheus (e.g. Grafana LGTM in dev) only stores cumulative. The Datadog agent
// accepts it, turning it into deltas itself, but drops each new series' first point, having nothing to subtract it
// from; set delta for Datadog to keep those.
const metricExporter = new OTLPMetricExporter({
    url: `${collectorUrl}/v1/metrics`
});

const views = new Array<ViewOptions>();

if (!isDev)
{
    // A view with only a meter name matches every metric that meter records, and each instrumentation's meter
    // is named after its package — the key it has in instrumentationConfig. Deriving the list from there means
    // enabling another instrumentation keeps its metrics out of prod without touching this.
    for (const [name, config] of Object.entries(instrumentationConfig))
        if (config.enabled === true && !(name in nonDevDroppedMetrics))
            views.push({ meterName: name, aggregation: { type: AggregationType.DROP } });

    for (const [meterName, instrumentNames] of Object.entries(nonDevDroppedMetrics))
        for (const instrumentName of instrumentNames)
            views.push({ meterName, instrumentName, aggregation: { type: AggregationType.DROP } });

    // Keep the request metric's tags to method, route and status, plus error.type, which marks a request that failed
    // before it had a status code; Datadog bills every tag combination. This leaves out url.scheme and
    // network.protocol.version, and any tag a later version of the instrumentation adds.
    views.push({
        meterName: "@opentelemetry/instrumentation-http",
        instrumentName: "http.server.request.duration",
        attributesProcessors: [
            createAllowListAttributesProcessor([
                "http.request.method", "http.route", "http.response.status_code", "error.type"
            ])
        ]
    });
}

const meterProvider = new MeterProvider({
    resource,
    views,
    // Counters and histograms lose nothing between pushes; a gauge is read only at each push.
    readers: [new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: metricsExportIntervalMs
    })]
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
let shutdownPromise: Promise<void> | null = null;

/**
 * Flushes any buffered spans and metrics and shuts the exporters down.
 *
 * Call this from your service's graceful-shutdown sequence — after it has stopped accepting work
 * and finished in-flight requests, so their spans are captured — to avoid losing the spans the
 * BatchSpanProcessor is still holding in memory and the metrics recorded since the last export.
 * Safe to call more than once: repeat calls return the same in-flight (or completed) shutdown.
 */
export function shutdownTelemetry(): Promise<void>
{
    if (shutdownPromise != null)
        return shutdownPromise;

    shutdownPromise = Promise.all([
        tracerProvider.shutdown().catch((e: unknown) =>
        {
            diag.error("Error shutting down tracer provider", e);
        }),
        meterProvider.shutdown().catch((e: unknown) =>
        {
            diag.error("Error shutting down meter provider", e);
        })
    ]).then(() => { /* both settled */ });

    return shutdownPromise;
}

/**
 * Flushes any buffered spans and metrics and shuts the exporters down.
 *
 * @deprecated Use {@link shutdownTelemetry}; this alias does the same, metrics included.
 */
export function shutdownTracing(): Promise<void>
{
    return shutdownTelemetry();
}
