module.exports = {
  reactStrictMode: true,

  // Increase the keep-alive timeout for outgoing HTTP connections used by the
  // built-in proxy (rewrites). The default Node.js keep-alive timeout is 5 s,
  // which is shorter than typical slow backend responses (6-7 s) and causes
  // ECONNRESET / "socket hang up" errors in Docker.
  httpAgentOptions: {
    keepAlive: true,
  },

  // Raise the proxy timeout for Next.js rewrites to 30 s so that slow backend
  // responses do not produce a premature ECONNRESET on the proxy leg.
  // (Available in Next.js >=13.5 via the experimental flag; harmless on older
  // versions where it is simply ignored.)
  experimental: {
    proxyTimeout: 30_000,
  },

  async rewrites() {
    return [
      { source: '/api/:path*', destination: 'http://backend:8000/api/:path*' },
    ];
  },
};
