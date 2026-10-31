import { createService } from './server.mjs';

// npm forwards preview flags after `--`; production still defaults to PORT.
let rawPort = process.env.PORT || '3000', host = '0.0.0.0', validArgs = true;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--port') rawPort = process.argv[++i] || '';
  else if (arg.startsWith('--port=')) rawPort = arg.slice(7);
  else if (arg === '--host') host = process.argv[++i] || '';
  else if (arg.startsWith('--host=')) host = arg.slice(7);
  else if (arg !== '--strictPort') validArgs = false;
}
if (!validArgs || !['0.0.0.0', '127.0.0.1', '::'].includes(host)) {
  console.error('{"event":"startup_failed","code":"invalid_arguments"}'); process.exit(1);
}
if (!/^[0-9]{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
  console.error('{"event":"startup_failed","code":"invalid_port"}'); process.exit(1);
}
let app;
try { app = createService({ publicOrigin: process.env.PUBLIC_ORIGIN, dataDir: process.env.DATA_DIR || '.ghost-data' }); }
catch {
  console.error('{"event":"startup_failed","code":"invalid_service_configuration"}'); process.exit(1);
}
let exiting = false;
async function shutdown() {
  if (exiting) return; exiting = true;
  await app.close(); process.exitCode = 0;
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
try {
  const address = await app.listen({ port: Number(rawPort), host });
  console.log(JSON.stringify({ event: 'listening', uid: process.getuid?.(), port: address.port, ready: app.ready }));
} catch {
  console.error('{"event":"startup_failed","code":"listen_failed"}');
  await app.close(); process.exitCode = 1;
}
