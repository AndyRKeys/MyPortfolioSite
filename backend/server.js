import 'dotenv/config';
import { createApp } from './app.js';

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set');
  process.exit(1);
}

const app  = createApp();
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
