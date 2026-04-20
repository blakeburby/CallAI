export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "run_arbitrage_scan",
      description:
        "Run a trading arbitrage scan and return current opportunities above the minimum expected value threshold.",
      parameters: {
        type: "object",
        properties: {
          min_ev: {
            type: "number",
            description: "Minimum expected value threshold for opportunities.",
            default: 0.03
          }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "place_trade",
      description:
        "Place a Kalshi trade for a supported crypto market direction and size.",
      parameters: {
        type: "object",
        properties: {
          asset: {
            type: "string",
            enum: ["BTC", "ETH", "SOL", "XRP"],
            description: "The asset to trade."
          },
          direction: {
            type: "string",
            enum: ["YES", "NO"],
            description: "The trade direction."
          },
          size: {
            type: "number",
            maximum: 0.05,
            description: "Trade size. Must be no more than 0.05."
          }
        },
        required: ["asset", "direction", "size"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_open_positions",
      description: "Return the currently open Kalshi positions.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "system_status",
      description:
        "Return model health, recent performance, bankroll, and open position count.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  }
] as const;

export default toolDefinitions;
