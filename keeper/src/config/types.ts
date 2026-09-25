export type SizingSource =
  | { source: "static"; priceUsd: number; confUsd: number }
  | { source: "prestocks"; ticker: string }
  | { source: "pyth"; equityFeedId: string; tokenFeedId: string };

export interface AssetCfg {
  label: string;
  mint: string;
  marketKind: "publicEquity" | "preIpo";
  sizing: SizingSource;
  issuer?: { source: "static"; priceUsd: number } | { source: "prestocks"; ticker: string };
}

export interface KeeperConfig {
  rpc: string;
  keypair: string;
  programId: string;
  stateFile: string;
  refreshSecs?: number;
  prestocksApi?: string;
  hermes?: string;
  assets: AssetCfg[];
}

export interface LineView {
  owner: string;
  session: string;
  collateralUsd: number;
  creditUsd: number;
  debtUsd: number;
  availableUsd: number;
  ltvBps: number;
  lastSizingAgeSecs: number;
  preIpoDrawWindowSecs: number;
  payoutMode: string;
  eventSeq: number;
  slots: {
    mint: string;
    label: string;
    marketKind: string;
    raw: number;
    decimals: number;
    estimatedUsd: number;
  }[];
}
