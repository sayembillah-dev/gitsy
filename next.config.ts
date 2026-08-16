import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // NOTE: BUILD-PLAN section 6 lists optimizePackageImports for
  // @phosphor-icons/react. Next 16 removed that key from NextConfig. Revisit
  // where it lives (or whether Turbopack makes it moot) when icons land in
  // Phase 4. Prefer the build-time SVG sprite either way (section 4).
};

export default nextConfig;
