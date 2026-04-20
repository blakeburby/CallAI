import "dotenv/config";
import { app } from "./app.js";
import { logger } from "./utils/logger.js";

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  logger.info(`CallAI tool server listening on port ${port}`);
});

export { app };
