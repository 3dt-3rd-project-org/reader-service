import { app } from '@azure/functions';
import { dbPool } from '../config/db.js';
import { neo4jDriver } from '../config/neo4j.js';
import { logger } from '../utils/logger.js';

app.http('getBooks', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'books',
  handler: async (request, context) => {
    logger.info('[User Books List] 전체 도서 목록 조회 및 검색/페이징 요청 접수');
    try {
      const type = request.query.get('type');
      const keyword = request.query.get('keyword');
      const startIdParam = request.query.get('startId');
      const limitParam = request.query.get('limit');

      let queryStr = "SELECT books_id, title, author, publisher, published_year, cover_url, isbn, status, updated_at FROM books WHERE status = 'COMPLETE'";
      const queryParams = [];

      // 1. 검색 조건 추가
      if (type && keyword) {
        const trimmedKeyword = keyword.trim();
        if (type === 'title') {
          queryParams.push(`%${trimmedKeyword}%`);
          queryStr += ` AND title ILIKE $${queryParams.length}`;
        } else if (type === 'author') {
          queryParams.push(`%${trimmedKeyword}%`);
          queryStr += ` AND author ILIKE $${queryParams.length}`;
        } else if (type === 'publisher') {
          queryParams.push(trimmedKeyword);
          queryStr += ` AND publisher = $${queryParams.length}`;
        }
      }

      // 2. 페이징 시작 도서 번호(N) 조건 추가 (startId 이하)
      if (startIdParam) {
        const startId = parseInt(startIdParam, 10);
        if (!isNaN(startId)) {
          queryParams.push(startId);
          queryStr += ` AND books_id <= $${queryParams.length}`;
        }
      }

      // 3. 최신 도서 순 정렬
      queryStr += " ORDER BY books_id DESC";

      // 4. 개수 제한(k) 조건 추가 (limit)
      if (limitParam) {
        const limit = parseInt(limitParam, 10);
        if (!isNaN(limit) && limit > 0) {
          queryParams.push(limit);
          queryStr += ` LIMIT $${queryParams.length}`;
        }
      }

      const result = await dbPool.query(queryStr, queryParams);
      logger.info(`[User Books List] 도서 목록 조회 성공 (결과 수: ${result.rows.length}개)`);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '도서 목록을 성공적으로 불러왔습니다.',
          books: result.rows
        })
      };
    } catch (err) {
      logger.error(`[User Books List] 조회/검색 오류: ${err.message}`);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal Server Error', message: err.message })
      };
    }
  }
});

app.http('getBookById', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'books/{id}',
  handler: async (request, context) => {
    logger.info(`[getBookById] 요청 접수 - 파라미터 id: ${request.params.id}`);
    const bookId = parseInt(request.params.id, 10);

    if (isNaN(bookId)) {
      return {
        status: 400,
        json: {
          error: 'Bad Request',
          message: '도서 식별자(id)는 유효한 정수여야 합니다.'
        }
      };
    }

    try {
      logger.info(`[getBookById] Database 쿼리 송신 준비 중... (Parameter: ${bookId})`);

      const result = await dbPool.query(
        'SELECT books_id, title, author, publisher, published_year, cover_url, isbn, status, updated_at FROM books WHERE books_id = $1',
        [bookId]
      );

      logger.info(`[getBookById] Database 쿼리 수신 완료. 반환된 레코드 수: ${result.rows.length}개`);

      if (result.rows.length === 0) {
        logger.warn(`[getBookById] 책 ID ${bookId}에 해당하는 도서가 DB에 없습니다.`);
        return {
          status: 404,
          json: {
            error: 'Not Found',
            message: '도서가 존재하지 않습니다.'
          }
        };
      }

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book: result.rows[0]
        })
      };
    } catch (err) {
      logger.error(`[getBookById] Database 쿼리 중 치명적 오류 발생! 메시지: ${err.message}`);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal Server Error', message: err.message })
      };
    }
  }
});

app.http('getBookRelations', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'books/{bookId}/relations',
  handler: async (request, context) => {
    const bookId = parseInt(request.params.bookId, 10);
    const pParam = request.query.get('p');

    if (isNaN(bookId)) {
      return {
        status: 400,
        json: { error: 'Bad Request', message: 'bookId 파라미터는 유효한 정수여야 합니다.' }
      };
    }

    const p = pParam !== null ? parseInt(pParam, 10) : 1;

    if (isNaN(p) || p < 0) {
      return {
        status: 400,
        json: { error: 'Bad Request', message: '문단 파라미터 p는 0 이상의 정수여야 합니다.' }
      };
    }

    logger.info(`[User Graph API] Book ID: ${bookId}, 문단 시점 p: ${p}`);

    const session = neo4jDriver.session();
    try {
      const query = `
        MATCH (n:Person)-[r:RELATED_TO]->(m:Person)
        WHERE r.book_id = $bookId AND r.start_paragraph_order <= $p
        RETURN n, r, m
      `;

      const result = await session.run(query, { bookId, p });

      const nodeMap = new Map();
      const edges = [];

      result.records.forEach(record => {
        const n = record.get('n');
        const r = record.get('r');
        const m = record.get('m');

        if (n) {
          const sourceId = String(n.identity);
          if (!nodeMap.has(sourceId)) {
            nodeMap.set(sourceId, {
              id: sourceId,
              name: n.properties.name,
              role: n.properties.role
            });
          }
        }

        if (m) {
          const targetId = String(m.identity);
          if (!nodeMap.has(targetId)) {
            nodeMap.set(targetId, {
              id: targetId,
              name: m.properties.name,
              role: m.properties.role
            });
          }
        }

        if (r) {
          edges.push({
            id: String(r.identity),
            source: String(r.start),
            target: String(r.end),
            type: r.properties.type || r.type,
            relation: r.properties.relation,
            start_paragraph_order: r.properties.start_paragraph_order
          });
        }
      });

      logger.info(`[User Graph API] Neo4j 조회 성공. 매핑된 노드 수: ${nodeMap.size}개, 관계 수: ${edges.length}개`);

      const responsePayload = {
        book_id: bookId,
        paragraph_limit: p,
        nodes: Array.from(nodeMap.values()),
        edges: edges
      };

      return {
        status: 200,
        headers: {
          'Cache-Control': 'public, max-age=86400',
          'X-Cache-Channel': `book-${bookId}-p-${p}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(responsePayload)
      };
    } catch (err) {
      logger.error(`[User Graph Relations Query] 오류: ${err.message}`);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal Server Error', message: err.message })
      };
    } finally {
      await session.close();
    }
  }
});
