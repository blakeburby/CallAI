import { database } from "../../services/dbService.js";
import type { AuditEventRecord } from "../../types/operator.js";
import { logger } from "../../utils/logger.js";

type AuditInput = {
  task_id?: string | null;
  run_id?: string | null;
  session_id?: string | null;
  event_type: string;
  severity?: AuditEventRecord["severity"];
  payload?: Record<string, unknown>;
};

export const auditLog = {
  async log(input: AuditInput): Promise<AuditEventRecord> {
    try {
      return await database.createAuditEvent(input);
    } catch (error) {
      logger.error("Failed to persist audit event", {
        error: error instanceof Error ? error.message : String(error),
        event_type: input.event_type
      });
      throw error;
    }
  },

  async forTask(taskId: string, limit = 50): Promise<AuditEventRecord[]> {
    return database.listAuditEvents({ taskId, limit });
  },

  async forSession(sessionId: string, limit = 50): Promise<AuditEventRecord[]> {
    return database.listAuditEvents({ sessionId, limit });
  }
};
