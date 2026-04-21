import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { frontendRouter } from "./routes/frontend.js";
import { healthRouter } from "./routes/health.js";
import { operatorRouter } from "./routes/operator.js";
import { runnerRouter } from "./routes/runner.js";
import { smsRouter } from "./routes/sms.js";
import { toolsRouter } from "./routes/tools.js";
import { voiceRouter } from "./routes/voice.js";
import { webhookRouter } from "./routes/webhook.js";
import { logger } from "./utils/logger.js";

export const app = express();
const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const publicDirectory = path.join(appRoot, "public");

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "256kb" }));

app.use(healthRouter);
app.use(frontendRouter);
app.use(operatorRouter);
app.use(toolsRouter);
app.use(voiceRouter);
app.use(runnerRouter);
app.use(smsRouter);
app.use(webhookRouter);
app.use(express.static(publicDirectory));

app.get("/", (_request, response) => {
  response.sendFile(path.join(publicDirectory, "index.html"));
});

app.use((_request, response) => {
  response.status(404).json({
    success: false,
    error: "Not found",
    message: "I ran into an issue processing that request."
  });
});

app.use(
  (
    error: Error,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction
  ) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        success: false,
        error: error.issues
          .map((issue) => {
            const location = issue.path.length ? issue.path.join(".") : "body";
            return `${location}: ${issue.message}`;
          })
          .join("; "),
        message: "I ran into an issue processing that request."
      });
      return;
    }

    logger.error("Unhandled server error", error);

    response.status(500).json({
      success: false,
      error: "Internal server error",
      message: "I ran into an issue processing that request."
    });
  }
);

export default app;
