import { logger } from '../utils/logger.js';

const REQUIRED_ENV_VARS = [
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
  'NEO4J_URI',
  'NEO4J_USER',
  'NEO4J_PASSWORD'
];

export function validateEnvironment() {
  const missingVars = [];

  for (const envVar of REQUIRED_ENV_VARS) {
    const val = process.env[envVar];
    if (!val || val.trim() === '' || val.includes('change-this-in-production')) {
      missingVars.push(envVar);
    }
  }

  if (missingVars.length > 0) {
    logger.error('\n================================================================');
    logger.error('[Reader Service Error] 필수 보안 환경변수가 누락되었습니다!');
    logger.error('================================================================');
    missingVars.forEach(v => logger.error(`  - ${v}`));
    logger.error('================================================================\n');
    process.exit(1);
  }

  logger.info('[Reader Service] 모든 필수 보안 환경변수 검증 통과 완료.');
}
