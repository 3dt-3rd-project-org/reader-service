import { app } from '@azure/functions';
import { dbPool } from '../config/db.js';
import { logger } from '../utils/logger.js';
import { authenticateToken } from '../shared/authHelper.js';

// 1. 독서 진도 저장
app.http('updateReadingProgress', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'books/{bookId}/progress',
  handler: async (request, context) => {
    const bookId = parseInt(request.params.bookId, 10);
    logger.info(`[User Progress API] 진도 저장 요청 접수 - Book ID: ${bookId}`);

    if (isNaN(bookId)) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Bad Request', message: 'bookId 파라미터는 유효한 정수여야 합니다.' })
      };
    }

    try {
      // JWT 인증
      const user = authenticateToken(request);
      const userId = user.id;

      const reqBody = await request.json();
      const { chapter_order, paragraph_order } = reqBody;

      if (chapter_order === undefined || paragraph_order === undefined) {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Bad Request', message: 'chapter_order와 paragraph_order 필드는 필수입니다.' })
        };
      }

      const chOrder = parseInt(chapter_order, 10);
      const pOrder = parseInt(paragraph_order, 10);

      if (isNaN(chOrder) || isNaN(pOrder)) {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Bad Request', message: 'chapter_order와 paragraph_order는 정수여야 합니다.' })
        };
      }

      // 1. chapter_order 에 대응하는 chapter_id 조회
      const chRes = await dbPool.query(
        'SELECT chapter_id FROM readpoint.chapter WHERE books_id = $1 AND chapter_order = $2',
        [bookId, chOrder]
      );

      if (chRes.rows.length === 0) {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Bad Request', message: '제공된 chapter_order가 해당 도서에 존재하지 않습니다.' })
        };
      }

      const chapterId = chRes.rows[0].chapter_id;

      // 2. paragraph_order 에 대응하는 paragraph_id 조회
      const pRes = await dbPool.query(
        'SELECT paragraph_id FROM readpoint.paragraph WHERE books_id = $1 AND chapter_id = $2 AND paragraph_order = $3',
        [bookId, chapterId, pOrder]
      );

      if (pRes.rows.length === 0) {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Bad Request', message: '제공된 paragraph_order가 해당 챕터에 존재하지 않습니다.' })
        };
      }

      const paragraphId = pRes.rows[0].paragraph_id;

      // 3. UPSERT 실행 (ON CONFLICT (user_id, book_id) DO UPDATE)
      const upsertRes = await dbPool.query(
        `INSERT INTO readpoint.reading_logs (user_id, book_id, chapter_id, last_read_paragraph_id, created_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, book_id)
         DO UPDATE SET 
             chapter_id = EXCLUDED.chapter_id,
             last_read_paragraph_id = EXCLUDED.last_read_paragraph_id,
             created_at = CURRENT_TIMESTAMP
         RETURNING id, user_id, book_id, chapter_id, last_read_paragraph_id, created_at`,
        [userId, bookId, chapterId, paragraphId]
      );

      logger.info(`[User Progress API] 진도 저장 성공 - User ID: ${userId}, Book ID: ${bookId}`);

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '독서 진도가 성공적으로 저장되었습니다.',
          progress: {
            id: upsertRes.rows[0].id,
            user_id: upsertRes.rows[0].user_id,
            book_id: upsertRes.rows[0].book_id,
            chapter_id: upsertRes.rows[0].chapter_id,
            chapter_order: chOrder,
            last_read_paragraph_id: upsertRes.rows[0].last_read_paragraph_id,
            paragraph_order: pOrder,
            created_at: upsertRes.rows[0].created_at
          }
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
      logger.error(`[User Progress API] 진도 저장 중 오류 발생: ${err.message}`);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal Server Error', message: err.message })
      };
    }
  }
});

// 2. 독서 진도 조회
app.http('getReadingProgress', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'books/{bookId}/progress',
  handler: async (request, context) => {
    const bookId = parseInt(request.params.bookId, 10);
    logger.info(`[User Progress API] 진도 조회 요청 접수 - Book ID: ${bookId}`);

    if (isNaN(bookId)) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Bad Request', message: 'bookId 파라미터는 유효한 정수여야 합니다.' })
      };
    }

    try {
      // JWT 인증
      const user = authenticateToken(request);
      const userId = user.id;

      // reading_logs 에서 해당 사용자 & 책 정보 조회
      const queryStr = `
        SELECT 
            rl.id,
            rl.user_id,
            rl.book_id,
            rl.chapter_id,
            c.chapter_order,
            rl.last_read_paragraph_id,
            p.paragraph_order,
            rl.created_at
        FROM readpoint.reading_logs rl
        JOIN readpoint.chapter c ON rl.chapter_id = c.chapter_id
        JOIN readpoint.paragraph p ON rl.last_read_paragraph_id = p.paragraph_id
        WHERE rl.user_id = $1 AND rl.book_id = $2;
      `;

      const result = await dbPool.query(queryStr, [userId, bookId]);

      if (result.rows.length === 0) {
        logger.info(`[User Progress API] 저장된 독서 진도가 없음 - User ID: ${userId}, Book ID: ${bookId}`);
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            progress: null
          })
        };
      }

      logger.info(`[User Progress API] 진도 조회 성공 - User ID: ${userId}, Book ID: ${bookId}`);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          progress: result.rows[0]
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
      logger.error(`[User Progress API] 진도 조회 중 오류 발생: ${err.message}`);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal Server Error', message: err.message })
      };
    }
  }
});
