// import type { NextConfig } from 'next';

// const nextConfig: NextConfig = {
//   experimental: {
//     ppr: true,
//   },
//   images: {
//     remotePatterns: [
//       {
//         hostname: 'avatar.vercel.sh',
//       },
//     ],
//   },
//   rewrites: async () => {
//     return [
//       {
//         source: '/api/flask/:path*',
//         destination:
//           process.env.NODE_ENV === 'development'
//             ? 'http://127.0.0.1:5328/api/:path*'
//             : '/api/',
//       },
//     ]
//   },
// };

// export default nextConfig;

import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: false,
  cacheComponents: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    remotePatterns: [
      {
        hostname: "avatar.vercel.sh",
      },
    ],
    unoptimized: true,
  },
  rewrites: async () => {
    return [
      {
        source: "/api/flask/:path*",
        destination: process.env.NODE_ENV === "development" ? "http://127.0.0.1:5328/api/:path*" : "/api/",
      },
    ]
  },
}

export default nextConfig
