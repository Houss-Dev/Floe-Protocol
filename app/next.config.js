const path = require("path");



const isProd = process.env.NODE_ENV === "production";

/** Set to "1" for E2B / embedded previews only — never on public production. */

const allowIframe = process.env.NEXT_PUBLIC_ALLOW_IFRAME === "1";



/** @type {import('next').NextConfig} */

const nextConfig = {

  reactStrictMode: true,

  outputFileTracingRoot: path.join(__dirname),

  transpilePackages: [

    "@ledgerline/ledgerline",

    "@solana/kit-plugin-wallet",

    "@solana/kit-plugin-rpc",

    "@solana/react",

  ],

  webpack: (config, { isServer }) => {

    // Prefer browser builds of Kit plugins (avoid Node entrypoints in client bundles).

    if (!isServer) {

      config.resolve.conditionNames = ["browser", "import", "require", "default"];

    }

    return config;

  },

  async redirects() {

    return [{ source: "/line", destination: "/dashboard", permanent: false }];

  },

  async headers() {

    const headers = [

      { key: "X-Content-Type-Options", value: "nosniff" },

      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

      {

        key: "Permissions-Policy",

        value: "camera=(), microphone=(), geolocation=(), payment=()",

      },

    ];



    // Strict CSP/HSTS only in production — dev HMR and webpack need a permissive environment.

    if (isProd) {

      headers.push({

        key: "Strict-Transport-Security",

        value: "max-age=63072000; includeSubDomains; preload",

      });

      if (allowIframe) {

        headers.push({

          key: "Content-Security-Policy",

          value:

            "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://*.e2b.app https://*.e2b.dev; object-src 'none'",

        });

      } else {

        headers.push({ key: "X-Frame-Options", value: "DENY" });

        headers.push({

          key: "Content-Security-Policy",

          value:

            "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https: wss:; font-src 'self' data:",

        });

      }

    }



    return [{ source: "/(.*)", headers }];

  },

};



module.exports = nextConfig;

