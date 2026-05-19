import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';

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
    logger.error({ err: error }, '[health] Health check failed — DB unreachable');
    res.status(503).json({
      status: 'error',
      db: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
}
