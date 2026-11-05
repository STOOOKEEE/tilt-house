/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PRIVY_APP_ID?: string
  readonly VITE_HOUSE_CONTRACT?: string
  readonly VITE_TOKEN_CONTRACT?: string
  readonly VITE_RELAYER_URL?: string
  readonly VITE_NEAR_RPC_URL?: string
  readonly VITE_SESSION_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
