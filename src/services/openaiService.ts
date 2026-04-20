import OpenAI from "openai";

const VOICE_SUMMARY_SYSTEM_PROMPT =
  "You are a trading assistant. Convert JSON data into one concise spoken sentence. No markdown. No numbers beyond 2 decimal places. Sound natural, not robotic.";

const INTENT_NAMES = [
  "run_arbitrage_scan",
  "get_open_positions",
  "place_trade",
  "system_status"
] as const;

type IntentName = (typeof INTENT_NAMES)[number];

let openaiClient: OpenAI | null = null;

const getOpenAIClient = (): OpenAI => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  return openaiClient;
};

export const summarizeForVoice = async (
  toolName: string,
  data: unknown
): Promise<string> => {
  const completion = await getOpenAIClient().chat.completions.create({
    model: "gpt-4o",
    max_tokens: 120,
    messages: [
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
    ]
  });

  return (
    completion.choices[0]?.message?.content?.trim() ||
    "I completed the request successfully."
  );
};

export const resolveIntent = async (transcript: string): Promise<string> => {
  const completion = await getOpenAIClient().chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 30,
    messages: [
      {
        role: "system",
        content:
          "Map the user's trading command to exactly one function name. Return only one of: run_arbitrage_scan, get_open_positions, place_trade, system_status."
      },
      {
        role: "user",
        content: transcript
      }
    ]
  });

  const resolved = completion.choices[0]?.message?.content?.trim() as
    | IntentName
    | undefined;

  if (resolved && INTENT_NAMES.includes(resolved)) {
    return resolved;
  }

  return "system_status";
};
