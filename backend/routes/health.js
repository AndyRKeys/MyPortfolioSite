import { pool } from '../db/pool.js';

export async function healthRouter(req, res) {
  try {
    // Lightweight health check: verify DB connectivity
    const result = await pool.query('SELECT NOW()');

    res.status(200).json({
      status: 'ok',
      db: 'ok',
      version: process.env.npm_package_version || 'unknown',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Health check failed:', error.message);
    res.status(503).json({
      status: 'error',
      db: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
}
