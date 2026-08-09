import * as Sentry from "@sentry/node";

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log("  ⚠️  Sentry DSN not configured — error monitoring disabled");
    return false;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
    beforeSend(event) {
      if (event.request?.headers) {
        const auth = event.request.headers["authorization"];
        if (auth) event.request.headers["authorization"] = "[REDACTED]";
      }
      return event;
    },
  });

  console.log("  ✅ Sentry error monitoring enabled");
  return true;
}

export function captureException(err: Error, context?: Record<string, any>) {
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(err, { extra: context });
  }
}

export { Sentry };
