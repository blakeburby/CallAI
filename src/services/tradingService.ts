type Asset = "BTC" | "ETH" | "SOL" | "XRP";
type Direction = "YES" | "NO";

export type ArbitrageOpportunity = {
  asset: Asset;
  ev: number;
  direction: Direction;
  confidence: number;
  timestamp: string;
};

export type OpenPosition = {
  asset: Asset;
  direction: Direction;
  size: number;
  entry_price: number;
  current_ev: number;
  unrealized_pnl: number;
};

export type FilledTrade = {
  trade_id: string;
  asset: Asset;
  direction: Direction;
  size: number;
  status: "filled";
  filled_at: string;
};

export type SystemStatus = {
  model_version: "v1.1";
  last_run: string;
  win_rate: number;
  bankroll: number;
  open_positions: number;
};

const nowIso = (): string => new Date().toISOString();

const allOpportunities = (): ArbitrageOpportunity[] => [
  {
    asset: "BTC",
    ev: 0.074,
    direction: "YES",
    confidence: 0.82,
    timestamp: nowIso()
  },
  {
    asset: "ETH",
    ev: 0.052,
    direction: "NO",
    confidence: 0.77,
    timestamp: nowIso()
  },
  {
    asset: "SOL",
    ev: 0.035,
    direction: "YES",
    confidence: 0.69,
    timestamp: nowIso()
  }
];

export const runScan = async (
  minEv = 0.03
): Promise<{ min_ev: number; opportunities: ArbitrageOpportunity[] }> => {
  const opportunities = allOpportunities().filter(
    (opportunity) => opportunity.ev >= minEv
  );

  return {
    min_ev: minEv,
    opportunities
  };
};

export const getPositions = async (): Promise<{ positions: OpenPosition[] }> => {
  return {
    positions: [
      {
        asset: "BTC",
        direction: "YES",
        size: 0.03,
        entry_price: 0.61,
        current_ev: 0.068,
        unrealized_pnl: 18.42
      },
      {
        asset: "ETH",
        direction: "NO",
        size: 0.02,
        entry_price: 0.44,
        current_ev: 0.031,
        unrealized_pnl: -4.15
      }
    ]
  };
};

export const placeTrade = async (
  asset: Asset,
  direction: Direction,
  size: number
): Promise<FilledTrade> => {
  if (size > 0.05) {
    throw new Error("Trade size must be less than or equal to 0.05");
  }

  return {
    trade_id: `trd_${Date.now()}_${asset.toLowerCase()}_${direction.toLowerCase()}`,
    asset,
    direction,
    size,
    status: "filled",
    filled_at: nowIso()
  };
};

export const getSystemStatus = async (): Promise<SystemStatus> => {
  return {
    model_version: "v1.1",
    last_run: nowIso(),
    win_rate: 0.58,
    bankroll: 1000,
    open_positions: 1
  };
};
