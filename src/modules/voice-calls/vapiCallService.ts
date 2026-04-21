import type { OutboundCallRequest } from "../../types/operator.js";

export const vapiCallService = {
  async startOutboundCall(input: OutboundCallRequest): Promise<{
    call_id?: string;
    status: string;
    phone_number: string;
  }> {
    const apiKey = process.env.VAPI_API_KEY;
    const assistantId = process.env.VAPI_ASSISTANT_ID;
    const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;

    if (!apiKey) {
      throw new Error("VAPI_API_KEY is required for outbound calls.");
    }

    if (!assistantId) {
      throw new Error("VAPI_ASSISTANT_ID is required for outbound calls.");
    }

    if (!phoneNumberId) {
      throw new Error("VAPI_PHONE_NUMBER_ID is required for outbound calls.");
    }

    const response = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        assistantId,
        phoneNumberId,
        customer: {
          number: input.phone_number
        },
        metadata: {
          reason: input.reason,
          task_id: input.task_id ?? null
        }
      }),
      signal: AbortSignal.timeout(20000)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Vapi outbound call failed with ${response.status}: ${detail}`);
    }

    const payload = (await response.json()) as {
      id?: string;
      status?: string;
    };

    return {
      call_id: payload.id,
      status: payload.status ?? "created",
      phone_number: input.phone_number
    };
  }
};
