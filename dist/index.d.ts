/**
 * Flushes any buffered spans and metrics and shuts the exporters down.
 *
 * Call this from your service's graceful-shutdown sequence — after it has stopped accepting work
 * and finished in-flight requests, so their spans are captured — to avoid losing the spans the
 * BatchSpanProcessor is still holding in memory and the metrics recorded since the last export.
 * Safe to call more than once: repeat calls return the same in-flight (or completed) shutdown.
 */
export declare function shutdownTelemetry(): Promise<void>;
/**
 * Flushes any buffered spans and metrics and shuts the exporters down.
 *
 * @deprecated Use {@link shutdownTelemetry}; this alias does the same, metrics included.
 */
export declare function shutdownTracing(): Promise<void>;
//# sourceMappingURL=index.d.ts.map