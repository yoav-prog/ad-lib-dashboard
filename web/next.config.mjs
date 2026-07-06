// Load the shared project secrets (../.env.local) for local development.
// In production (Vercel), these come from the project's environment variables.
import { config } from 'dotenv';
config({ path: '../.env.local' });

/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
