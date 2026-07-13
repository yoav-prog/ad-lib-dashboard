// Load the shared project secrets (../.env.local) for local development.
// In production (Vercel), these come from the project's environment variables.
import { config } from 'dotenv';
config({ path: '../.env.local' });

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Raise the Server Action request-body limit (default 1 MB) so a full Sheet
    // export can send every filtered ad id in one call. Each id is ~18 bytes of
    // JSON, so 4 MB covers ~200k ads - far past any realistic feed. Every action
    // here is admin-gated, so the loosened limit is not a public DDoS surface.
    serverActions: { bodySizeLimit: '4mb' },
  },
};

export default nextConfig;
