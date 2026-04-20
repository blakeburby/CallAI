import express from "express";
import { healthRouter } from "./routes/health.js";
import { toolsRouter } from "./routes/tools.js";
import { webhookRouter } from "./routes/webhook.js";
import { logger } from "./utils/logger.js";

export const app = express();

app.use(express.json({ limit: "1mb" }));

app.use(healthRouter);
app.use(toolsRouter);
app.use(webhookRouter);

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
    logger.error("Unhandled server error", error);

    response.status(500).json({
      success: false,
      error: "Internal server error",
      message: "I ran into an issue processing that request."
    });
  }
);
