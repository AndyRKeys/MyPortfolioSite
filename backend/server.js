import 'dotenv/config';
import { createApp } from './app.js';

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set');
  process.exit(1);
}

const app  = createApp();
const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});

// Graceful shutdown on SIGTERM (Docker stop, Kubernetes termination, etc)
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing connections...');
  server.close(() => {
    console.log('Server closed, exiting');
    process.exit(0);
  });
  // Force exit after 10s if connections don't close
  setTimeout(() => {
    console.error('Forced exit after 10s');
    process.exit(1);
  }, 10000);
});
