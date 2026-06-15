import { app } from '@azure/functions';
import { dbPool } from '../config/db.js';
import { logger } from '../utils/logger.js';
import { authenticateToken } from '../shared/authHelper.js';

// 1. 도서 목록 조회 및 검색/페이징
app.http('getBooks', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'books',
  handler: async (request, context) => {
    logger.info('[User Books List] 도서 목록 조회 및 검색/페이징 요청 접수');
    try {
      const type = request.query.get('type');
      const keyword = request.query.get('keyword');
      const startIdParam = request.query.get('startId');
      const limitParam = request.query.get('limit');

      const authHeader = request.headers.get('authorization');
      const token = authHeader && authHeader.split(' ')[1];

      let queryStr;
      const queryParams = [];
      let alias = '';

      if (token) {
        // 토큰이 있는 경우: 사용자 인증 후, 사용자가 읽고 있는 도서 목록 조회 대상 설정
        const user = authenticateToken(request);
        const userId = user.id;
        logger.info(`[User Books List] 인증된 사용자(${userId})의 독서 중인 도서 목록 조회 준비`);

        queryStr = `
          SELECT 
              b.books_id, 
              b.title, 
              b.author, 
              b.publisher, 
              b.published_year, 
              b.cover_url, 
              b.isbn, 
              b.status, 
              b.updated_at,
              rl.created_at AS last_read_at,
              rl.chapter_id AS last_read_chapter_id,
              c.chapter_order AS last_read_chapter_order,
              rl.last_read_paragraph_id AS last_read_paragraph_id,
              p.paragraph_order AS last_read_paragraph_order
          FROM readpoint.reading_logs rl
          JOIN books b ON rl.book_id = b.books_id
          LEFT JOIN readpoint.chapter c ON rl.chapter_id = c.chapter_id
          LEFT JOIN readpoint.paragraph p ON rl.last_read_paragraph_id = p.paragraph_id
          WHERE rl.user_id = $1 AND b.status = 'COMPLETE'
        `;
        queryParams.push(userId);
        alias = 'b.';
      } else {
        // 토큰이 없는 경우: 전체 도서 목록 조회 대상 설정
        logger.info('[User Books List] 비로그인 유저 전체 도서 목록 조회 준비');
        queryStr = `
          SELECT 
              books_id, 
              title, 
              author, 
              publisher, 
              published_year, 
              cover_url, 
              isbn, 
              status, 
              updated_at 
          FROM books 
          WHERE status = 'COMPLETE'
        `;
        alias = '';
      }

      // --- 공통 필터 및 페이징 처리 ---

      // 1. 검색 조건 추가
      if (type && keyword) {
        const trimmedKeyword = keyword.trim();
        if (type === 'title') {
          queryParams.push(`%${trimmedKeyword}%`);
          queryStr += ` AND ${alias}title ILIKE $${queryParams.length}`;
        } else if (type === 'author') {
          queryParams.push(`%${trimmedKeyword}%`);
          queryStr += ` AND ${alias}author ILIKE $${queryParams.length}`;
        } else if (type === 'publisher') {
          queryParams.push(trimmedKeyword);
          queryStr += ` AND ${alias}publisher = $${queryParams.length}`;
        }
      }

      // 2. 페이징 시작 도서 번호(N) 조건 추가 (startId 이하)
      if (startIdParam) {
        const startId = parseInt(startIdParam, 10);
        if (!isNaN(startId)) {
          queryParams.push(startId);
          queryStr += ` AND ${alias}books_id <= $${queryParams.length}`;
        }
      }

      // 3. 최신 도서 순 정렬
      queryStr += ` ORDER BY ${alias}books_id DESC`;

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
          message: token ? '사용자가 읽고 있는 도서 목록을 성공적으로 불러왔습니다.' : '도서 목록을 성공적으로 불러왔습니다.',
          books: result.rows
        })
      };
    } catch (err) {
      if (err.status) {
        return {
          status: err.status,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(err.body)
        };
      }
      logger.error(`[User Books List] 조회/검색 오류: ${err.message}`);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal Server Error', message: err.message })
      };
    }
  }
});

// 2. 도서 단건 상세 조회
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
        'SELECT books_id, title, author, publisher, published_year, cover_url, isbn, status, updated_at, epub_blob_path FROM books WHERE books_id = $1',
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
