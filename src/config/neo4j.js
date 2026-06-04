import neo4j from 'neo4j-driver';
import { logger } from '../utils/logger.js';

let neo4jDriver;

try {
  neo4jDriver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
  );
  logger.info('[Reader Service] Neo4j 드라이버 연결 수립을 마쳤습니다.');
} catch (err) {
  logger.error('[Reader Service] Neo4j 드라이버 연결 실패:', err.message);
  throw err;
}

export { neo4jDriver };
