import assert from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import test, { after, before, describe } from "node:test";
import { fileURLToPath } from "node:url";


// Runs the fixture app under `--import` n-strument against a fake OTLP receiver and inspects what it sends.

interface OtlpAttribute
{
    key: string;
}

interface OtlpDataPoints
{
    aggregationTemporality?: number;
    dataPoints: Array<{ attributes?: Array<OtlpAttribute>; }>;
}

interface OtlpMetric
{
    name: string;
    sum?: OtlpDataPoints;
    histogram?: OtlpDataPoints;
    gauge?: OtlpDataPoints;
}

interface OtlpBody
{
    resourceSpans?: Array<{ resource?: { attributes?: Array<OtlpAttribute>; }; }>;
    resourceMetrics?: Array<{
        resource?: { attributes?: Array<OtlpAttribute>; };
        scopeMetrics: Array<{ metrics: Array<OtlpMetric>; }>;
    }>;
}

interface OtlpRequest
{
    path: string;
    body: OtlpBody;
}

interface RunResult
{
    requests: Array<OtlpRequest>;
    incomingHeaders: Record<string, string | Array<string> | undefined>;
    stderr: string;
}

const srcIndexUrl = new URL("../src/index.js", import.meta.url);
const fixturePath = fileURLToPath(new URL("./fixtures/app.js", import.meta.url));

const received = new Array<OtlpRequest>();

const receiver = createServer((req, res) =>
{
    const chunks = new Array<Buffer>();
    req.on("data", (t: Buffer) => chunks.push(t));
    req.on("end", () =>
    {
        const text = Buffer.concat(chunks).toString("utf8");
        received.push({ path: req.url ?? "", body: (text.length > 0 ? JSON.parse(text) : {}) as OtlpBody });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
    });
});

async function runFixture(config: Record<string, string>): Promise<RunResult>
{
    received.length = 0;
    const receiverPort = (receiver.address() as AddressInfo).port;

    const child = spawn(process.execPath, ["--expose-gc", "--import", srcIndexUrl.href, fixturePath], {
        // The host is pinned rather than defaulted: non-dev defaults to 0.0.0.0, and dev's localhost can resolve
        // to ::1. The port is the receiver's.
        env: { PATH: process.env.PATH, otelTraceHost: `127.0.0.1:${receiverPort}`, package_name: "smoke", ...config },
        stdio: ["ignore", "pipe", "pipe"],
        // node:test has no default timeout, so a fixture that hangs (e.g. on a shutdown that never settles) would
        // hang the suite. The abort kills it and surfaces as an 'error'.
        signal: AbortSignal.timeout(15_000)
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (t: Buffer) => stdout += t.toString());
    child.stderr.on("data", (t: Buffer) => stderr += t.toString());

    const exitCode = await new Promise<number | null>((resolve, reject) =>
    {
        child.on("error", (e) => reject(new Error(`fixture failed: ${e.message}\n${stderr}`)));
        child.on("close", resolve);
    });
    assert.strictEqual(exitCode, 0, `fixture exited with ${String(exitCode)}\n${stderr}`);

    const headersLine = stdout.split("\n").find(t => t.startsWith("{\"incomingHeaders\""));
    assert.ok(headersLine != null, `fixture printed no incoming headers\n${stdout}`);

    return {
        requests: [...received],
        incomingHeaders: (JSON.parse(headersLine) as Pick<RunResult, "incomingHeaders">).incomingHeaders,
        stderr
    };
}

function metricPushes(run: RunResult): number
{
    return run.requests.filter(t => t.path === "/v1/metrics").length;
}

function paths(run: RunResult): Set<string>
{
    return new Set(run.requests.map(t => t.path));
}

function assertResourceIsMinimal(run: RunResult): void
{
    const keys = run.requests.flatMap(t => [...t.body.resourceSpans ?? [], ...t.body.resourceMetrics ?? []])
        .flatMap(t => t.resource?.attributes ?? [])
        .map(t => t.key);

    assert.ok(keys.includes("service.name"));
    for (const key of keys)
        assert.ok(key === "service.name" || key === "service.version" || key.startsWith("telemetry.sdk."),
            `unexpected resource attribute '${key}'`);
}

function metricsByName(run: RunResult): Map<string, OtlpMetric>
{
    return new Map(run.requests
        .flatMap(t => t.body.resourceMetrics ?? [])
        .flatMap(t => t.scopeMetrics)
        .flatMap(t => t.metrics)
        .map(t => [t.name, t]));
}

function temporalityOf(metric: OtlpMetric | undefined): number | undefined
{
    return (metric?.sum ?? metric?.histogram)?.aggregationTemporality;
}

function attributeKeysOf(metric: OtlpMetric | undefined): Set<string>
{
    return new Set((metric?.histogram?.dataPoints ?? []).flatMap(t => t.attributes ?? []).map(t => t.key));
}

const otlpDelta = 1;
const otlpCumulative = 2;


await describe("telemetry", async () =>
{
    before(async () =>
    {
        // Any free port, so the suite runs alongside a local collector (e.g. LGTM) holding the standard 4318.
        await new Promise<void>((resolve, reject) =>
        {
            receiver.once("error", reject);
            receiver.listen(0, "127.0.0.1", () => resolve());
        });
    });

    after(async () =>
    {
        await new Promise<void>((resolve) => receiver.close(() => resolve()));
    });

    await test("outside dev, exports traces, custom metrics and only the instrumentation metrics not dropped, as cumulative, never logs, with a minimal resource and W3C propagation", async () =>
    {
        const run = await runFixture({ env: "prod" });

        assert.ok(paths(run).has("/v1/traces"));
        assert.ok(!paths(run).has("/v1/logs"));
        assertResourceIsMinimal(run);
        assert.ok(run.incomingHeaders["traceparent"] != null);

        // Not here: the rest of runtime-node's and http's metrics, pg's db.client.operation.duration (dropped by
        // name), and kafkajs's messaging.* (an instrumentation dropped whole).
        const metrics = metricsByName(run);
        assert.deepStrictEqual([...metrics.keys()].sort(), [
            "db.client.connection.count",
            "http.server.request.duration",
            "nodejs.eventloop.delay.p99",
            "nodejs.eventloop.utilization",
            "smoke.events"
        ]);

        const httpAttributeKeys = attributeKeysOf(metrics.get("http.server.request.duration"));
        assert.ok(httpAttributeKeys.has("http.request.method") && httpAttributeKeys.has("http.response.status_code"));
        for (const key of httpAttributeKeys)
            assert.ok(["http.request.method", "http.route", "http.response.status_code", "error.type"].includes(key),
                `unexpected http.server.request.duration attribute '${key}'`);

        assert.strictEqual(temporalityOf(metrics.get("smoke.events")), otlpCumulative);
        assert.strictEqual(temporalityOf(metrics.get("http.server.request.duration")), otlpCumulative);
    });

    await test("in dev, exports the full automatic set, as cumulative", async () =>
    {
        const run = await runFixture({ env: "dev" });

        assert.ok(!paths(run).has("/v1/logs"));

        const metrics = metricsByName(run);
        for (const name of ["smoke.events", "http.server.request.duration", "http.client.request.duration", "v8js.gc.duration",
            "nodejs.eventloop.utilization", "db.client.operation.duration", "messaging.client.sent.messages"])
            assert.ok(metrics.has(name), `missing ${name}; got ${[...metrics.keys()].join(", ")}`);

        for (const name of ["smoke.events", "http.server.request.duration", "http.client.request.duration", "v8js.gc.duration"])
            assert.strictEqual(temporalityOf(metrics.get(name)), otlpCumulative, `${name} should be cumulative`);

        // Only the fixture's own request: the export it forces ahead of shutdown would add a second data point (the
        // receiver's port) if the exporters' requests were recorded.
        assert.strictEqual(metrics.get("http.client.request.duration")?.histogram?.dataPoints.length, 1,
            "http.client.request.duration should not record the exporters' requests");
    });

    await test("with X-Ray on, propagates X-Amzn-Trace-Id instead of traceparent", async () =>
    {
        const run = await runFixture({ env: "prod", enableXrayTracing: "true" });

        assert.ok(run.incomingHeaders["x-amzn-trace-id"] != null);
        assert.strictEqual(run.incomingHeaders["traceparent"], undefined);
    });

    await test("honours OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", async () =>
    {
        const run = await runFixture({ env: "prod", OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "delta" });

        const metrics = metricsByName(run);
        assert.strictEqual(temporalityOf(metrics.get("smoke.events")), otlpDelta);
        assert.strictEqual(temporalityOf(metrics.get("http.server.request.duration")), otlpDelta);
    });

    await test("honours OTEL_METRIC_EXPORT_INTERVAL", async () =>
    {
        // Alive for 2.5s with a 1s interval: two periodic pushes, plus the one on shutdown.
        const run = await runFixture({ env: "prod", OTEL_METRIC_EXPORT_INTERVAL: "1000", FIXTURE_WAIT_MS: "2500" });

        const pushes = metricPushes(run);
        assert.ok(pushes >= 3, `expected at least 3 metric pushes, got ${pushes}`);
    });

    await test("ignores, with a warning, an OTEL_METRIC_EXPORT_INTERVAL that isn't 1 to 2^31-1 milliseconds", async () =>
    {
        // At or below 0 the reader throws at import; past 2^31-1 Node fires the timer every millisecond.
        for (const value of ["0", "-1", "Infinity", "3000000000"])
        {
            const run = await runFixture({ env: "prod", OTEL_METRIC_EXPORT_INTERVAL: value });

            assert.ok(run.stderr.includes("OTEL_METRIC_EXPORT_INTERVAL"), `no warning for ${value}\n${run.stderr}`);
            // Only the fixture's forced export and the one on shutdown, at the 60s default.
            const pushes = metricPushes(run);
            assert.ok(pushes <= 3, `expected at most 3 metric pushes for ${value}, got ${pushes}`);
        }
    });
});
