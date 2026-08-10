module.exports = {
  apps: [
    {
      name: 'inventory-api',
      script: 'dist/index.js',
      cwd: 'D:\\inventory-railway',
      env: {
        NODE_ENV: 'production',
        PORT: '4001',
      },
      max_memory_restart: '256M',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
    {
      name: 'cloudflared-tunnel',
      script: 'C:\\Users\\ahmed\\cloudflared.exe',
      args: 'tunnel --url http://localhost:4001',
      watch: false,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 5000,
    },
  ],
};
