import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import travelRoutes from './routes/travel.js';
import contactRoutes from './routes/contact.js';
import uploadRoutes from './routes/upload.js';
import postsRoutes from './routes/posts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5500';
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin requests (no origin header) and any localhost port in dev
    if (!origin || origin === ALLOWED_ORIGIN ||
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      cb(null, true);
    } else {
      cb(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));

// Serve uploaded files in dev (Nginx handles this in production)
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use('/auth', authRoutes);
app.use('/travel', travelRoutes);
app.use('/contact', contactRoutes);
app.use('/upload', uploadRoutes);
app.use('/posts', postsRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
