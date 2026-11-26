import { createGateway, loadConfig } from './gateway.js';

const upstream = process.env.NEW_API_URL;
if (!upstream) throw new Error('Set NEW_API_URL to your existing New API root URL.');
const configPath = process.env.TFA_CONFIG || 'config/config.json';
await loadConfig(configPath);
const server = createGateway({ upstream, configPath });
server.listen(Number(process.env.PORT || 3001), '0.0.0.0', () => {
  console.log(`New API FC Gateway listening on port ${server.address().port}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close());
