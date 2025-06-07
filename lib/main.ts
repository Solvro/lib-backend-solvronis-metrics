import { ExtendedMap as EMap } from "@solvro/utils/map";

import { HttpContext as AdonisHttpContext } from "@adonisjs/core/http";
import logger from "@adonisjs/core/services/logger";
import { NextFn } from "@adonisjs/core/types/http";

interface RouteTimingEntry {
  timestamp: number;
  // ms
  timeElapsed: number;
}

/**
 * Extra HttpContext properties added by this module
 */
export interface MetricsHttpContextExtras {
  metrics?: {
    /**
     * Timestamp taken just before request processing began
     */
    startTime?: number;
    /**
     * Was recordResponse() called on this request yet?
     * Prevents a request from being recorded twice.
     */
    recorded?: true;
  };
}

type HttpContext = AdonisHttpContext & MetricsHttpContextExtras;

class Metrics {
  requestCount = 0;
  requestTimingHistory: RouteTimingEntry[] = [];

  clearOldTimings() {
    const now = Date.now();
    let shifted;
    do {
      shifted = this.requestTimingHistory.shift();
    } while (
      shifted !== undefined &&
      now - shifted.timestamp > HISTORY_RETAIN_DURATION
    );

    if (shifted !== undefined) {
      this.requestTimingHistory.unshift(shifted);
    }
  }
}

const HISTORY_RETAIN_DURATION = 60 * 1000;

/**
 * route pattern -> http method -> response status -> metrics object
 *
 * there's a special "invalid route" route pattern for requests that had no route
 */
export const metrics = new EMap<string, EMap<string, EMap<number, Metrics>>>();

/**
 * Manually record a response
 *
 * You should register this module as a global middleware instead of manually recording reponses.
 * But if you must, this function exists. Call this function with an HttpContext after a response has been emitted.
 * To collect request timings, you must set the metrics.startTime property on the HttpContext to Date.now() before
 * starting the request processing.
 *
 * @param ctx the http context
 */
export function recordResponse(ctx: HttpContext) {
  // ensure we don't record the same response twice
  ctx.metrics ??= {};
  if (ctx.metrics.recorded === true) {
    logger.warn(
      `A request was attempted to be recorded twice! Stack trace: ${new Error().stack}`,
    );
    return;
  }
  ctx.metrics.recorded = true;
  const { request, response, route, metrics: reqMetrics } = ctx;

  // record response timing
  const timeElapsed =
    reqMetrics.startTime !== undefined
      ? performance.now() - reqMetrics.startTime
      : undefined;

  // get the right metrics bucket
  const metricsEntry = metrics
    .getOrInsertWith(route?.pattern ?? "invalid route", () => new EMap())
    .getOrInsertWith(request.method(), () => new EMap())
    .getOrInsertWith(response.getStatus(), () => new Metrics());

  // record response
  metricsEntry.requestCount += 1;
  if (timeElapsed !== undefined) {
    metricsEntry.clearOldTimings();
    metricsEntry.requestTimingHistory.push({
      timestamp: Date.now(),
      timeElapsed,
    });
  }
}

interface Summary {
  quantiles: Record<string, number>;
  sum: number;
  count: number;
}

const QUANTILES: [number, string][] = [
  [0.1, "0.1"],
  [0.25, "0.25"],
  [0.5, "0.5"],
  [0.75, "0.75"],
  [0.9, "0.9"],
  [0.95, "0.95"],
  [0.99, "0.99"],
];

function calculateSummary(sorted: number[]): Summary {
  const result: Summary = {
    quantiles: {},
    sum: sorted.reduce((acc, cur) => acc + cur, 0),
    count: sorted.length,
  };
  if (sorted.length === 0) {
    return result;
  }

  for (const [quantNum, quantStr] of QUANTILES) {
    const idx = Math.ceil(quantNum * sorted.length) - 1;
    if (sorted[idx] === undefined) {
      continue;
    }
    result.quantiles[quantStr] = sorted[idx];
  }

  return result;
}

/**
 * Emit metrics in a prometheus-compatible format.
 *
 * You may immediately send these metrics off as the response, or you may append custom ones.
 *
 * @returns collected metrics serialized in a prometheus-compatible format
 */
export function emitMetrics(): string {
  const result: string[] = [
    "# HELP solvronis_global_response_timings A summary of response timings for requests made to all endpoints, in ms",
    "# TYPE solvronis_global_response_timings summary",
    "# HELP solvronis_route_response_timings A summary of response timings for requests made to a particular route, in ms",
    "# TYPE solvronis_route_response_timings summary",
    "# HELP solvronis_route_status_response_timings A summary of response timings for requests made to a particular route that resulted in a specific status code, in ms",
    "# TYPE solvronis_route_status_response_timings summary",
    "# HELP solvronis_route_request_count Count of all requests made to a particular route that resulted in a specific status code",
    "# TYPE solvronis_route_request_count counter",
  ];

  const globalTimings: number[][] = [];
  for (const [routeName, routeBuckets] of metrics.entries()) {
    for (const [method, methodBuckets] of routeBuckets.entries()) {
      const routeTimings: number[][] = [];
      for (const [status, statusBucket] of methodBuckets.entries()) {
        statusBucket.clearOldTimings();
        result.push(
          `solvronis_route_request_count{route="${routeName}", method="${method}", status="${status}"} ${statusBucket.requestCount}`,
        );

        if (statusBucket.requestTimingHistory.length === 0) {
          continue;
        }
        const statusTimings = statusBucket.requestTimingHistory
          .map((h) => h.timeElapsed)
          .sort((a, b) => a - b);
        routeTimings.push(statusTimings);
        const summary = calculateSummary(statusTimings);

        for (const [quantile, value] of Object.entries(summary.quantiles)) {
          result.push(
            `solvronis_route_status_response_timings{route="${routeName}", method="${method}", status="${status}", quantile="${quantile}"} ${value}`,
          );
        }
        result.push(
          `solvronis_route_status_response_timings_sum{route="${routeName}", method="${method}", status="${status}"} ${summary.sum}`,
        );
        result.push(
          `solvronis_route_status_response_timings_count{route="${routeName}", method="${method}", status="${status}"} ${summary.count}`,
        );
      }

      if (routeTimings.length === 0) {
        continue;
      }
      const routeFlattened = routeTimings.flat().sort((a, b) => a - b);
      globalTimings.push(routeFlattened);
      const summary = calculateSummary(routeFlattened);

      for (const [quantile, value] of Object.entries(summary.quantiles)) {
        result.push(
          `solvronis_route_response_timings{route="${routeName}", method="${method}", quantile="${quantile}"} ${value}`,
        );
      }
      result.push(
        `solvronis_route_response_timings_sum{route="${routeName}", method="${method}"} ${summary.sum}`,
      );
      result.push(
        `solvronis_route_response_timings_count{route="${routeName}", method="${method}"} ${summary.count}`,
      );
    }
  }

  if (globalTimings.length > 0) {
    const globalFlattened = globalTimings.flat().sort((a, b) => a - b);
    const summary = calculateSummary(globalFlattened);

    for (const [quantile, value] of Object.entries(summary.quantiles)) {
      result.push(
        `solvronis_global_response_timings{quantile="${quantile}"} ${value}`,
      );
    }
    result.push(`solvronis_global_response_timings_sum ${summary.sum}`);
    result.push(`solvronis_global_response_timings_count ${summary.count}`);
  }

  return result.join("\n");
}

/**
 * The metrics middleware. Collects the request counts & response timings of all wrapped controllers.
 *
 * This class also contains the emitMetrics function, which you can register as a controller.
 */
export default class MetricsMiddleware {
  async handle(c: AdonisHttpContext, next: NextFn) {
    const ctx = c as HttpContext;
    ctx.metrics ??= {};
    ctx.metrics.startTime = performance.now();
    await next();
    recordResponse(ctx);
  }

  emitMetrics = emitMetrics;
}
