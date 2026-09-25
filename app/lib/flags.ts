/** Devnet sandbox UI (dashboard). Off in production unless explicitly enabled at build time. */
export const devnetSandboxEnabled =
  process.env.NODE_ENV === "development" ||
  process.env.NEXT_PUBLIC_ENABLE_DEVNET_SANDBOX === "1";

/** Init config / add asset — never on public production builds. */
export const devnetAdminEnabled =
  process.env.NODE_ENV === "development" ||
  process.env.NEXT_PUBLIC_ENABLE_DEVNET_ADMIN === "1";
