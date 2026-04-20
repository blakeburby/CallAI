const VOICE_SUMMARY_SYSTEM_PROMPT =
  "You are a trading assistant. Convert JSON data into one concise spoken sentence. No markdown. No numbers beyond 2 decimal places. Sound natural, not robotic.";

const INTENT_NAMES = [
  "run_arbitrage_scan",
  "get_open_positions",
  "place_trade",
  "system_status"
] as const;

type IntentName = (typeof INTENT_NAMES)[number];

type ChatMessage = {
  role: "system" | "user";
  content: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

const chatCompletion = async (
  model: string,
  maxTokens: number,
  messages: ChatMessage[]
): Promise<string> => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages
    }),
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed with ${response.status}: ${errorText}`);
  }

  const completion = (await response.json()) as ChatCompletionResponse;

  return completion.choices?.[0]?.message?.content?.trim() || "";
};

export const summarizeForVoice = async (
  toolName: string,
  data: unknown
): Promise<string> => {
  const summary = await chatCompletion("gpt-4o", 120, [
    {
      role: "system",
      content: VOICE_SUMMARY_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: JSON.stringify({
        toolName,
        data
      })
    }
  ]);

  return summary || "I completed the request successfully.";
};

export const resolveIntent = async (transcript: string): Promise<string> => {
  const resolved = (await chatCompletion("gpt-4o-mini", 30, [
    {
      role: "system",
      content:
        "Map the user's trading command to exactly one function name. Return only one of: run_arbitrage_scan, get_open_positions, place_trade, system_status."
    },
    {
      role: "user",
      content: transcript
    }
  ])) as IntentName;

  if (INTENT_NAMES.includes(resolved)) {
    return resolved;
  }

  return "system_status";
};
