import { app } from '@azure/functions';
import { dbPool } from '../config/db.js';
import { logger } from '../utils/logger.js';

// 1. 도서 챕터 목록 조회
app.http('getBookChapters', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'books/{bookId}/chapters',
  handler: async (request, context) => {
    const bookId = parseInt(request.params.bookId, 10);

    if (isNaN(bookId)) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Bad Request',
          message: 'bookId 파라미터는 유효한 정수여야 합니다.'
        })
      };
    }

    logger.info(`[User Chapters API] Book ID: ${bookId} 챕터 목록 조회 요청 접수`);
    try {
      const result = await dbPool.query(
        'SELECT chapter_id, books_id, chapter_order, title FROM chapter WHERE books_id = $1 ORDER BY chapter_order ASC',
        [bookId]
      );

      logger.info(`[User Chapters API] 챕터 조회 성공 (결과 수: ${result.rows.length}개)`);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: bookId,
          chapters: result.rows
        })
      };
    } catch (err) {
      logger.error(`[User Chapters API] 조회 오류: ${err.message}`);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal Server Error', message: err.message })
      };
    }
  }
});
