// Конфигурация PM2: pm2 start ecosystem.config.js
// Сервер раздаёт и API, и собранный Angular-клиент — один процесс, один порт.
module.exports = {
  apps: [
    {
      name: 'mixmarkt-crm',
      script: 'server/dist/index.js',
      cwd: __dirname + '/server',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
    },
  ],
};
