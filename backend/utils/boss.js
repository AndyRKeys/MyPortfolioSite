import PgBoss from 'pg-boss';
import { logger } from './logger.js';

let boss = null;

export function getBoss() {
  return boss;
}

export async function initBoss() {
  boss = new PgBoss({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'portfolio_db',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD,
    // Keep pg-boss schema maintenance quiet in application logs.
    noSupervisor: false,
  });

  boss.on('error', (err) =>
    logger.error({ err: err.message }, '[boss] pg-boss error')
  );

  await boss.start();
  logger.info('[boss] pg-boss started');
  return boss;
}
