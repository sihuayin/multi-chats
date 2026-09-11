import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  serverExternalPackages: [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "pg"
  ]
};

export default nextConfig;
