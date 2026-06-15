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

app.http('getBookRelations', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'books/{bookId}/relations',
  handler: async (request, context) => {
    const bookId = parseInt(request.params.bookId, 10);
    const chapterParam = request.query.get('c') || request.query.get('chapter');
    const pParam = request.query.get('p') || request.query.get('para') || request.query.get('paragraph');

    if (isNaN(bookId)) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Bad Request', message: 'bookId 파라미터는 유효한 정수여야 합니다.' })
      };
    }

    // 기본값 설정 (파라미터 누락 시 1)
    const chapter = chapterParam !== null ? parseInt(chapterParam, 10) : 1;
    const p = pParam !== null ? parseInt(pParam, 10) : 1;

    if (isNaN(chapter) || chapter < 1) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Bad Request', message: '챕터 파라미터 c(또는 chapter)는 1 이상의 정수여야 합니다.' })
      };
    }

    if (isNaN(p) || p < 0) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Bad Request', message: '문단 파라미터 p(또는 para)는 0 이상의 정수여야 합니다.' })
      };
    }

    logger.info(`[User Graph API] Book ID: ${bookId}, Chapter 시점: ${chapter}, Paragraph 시점: ${p}`);

    const session = neo4jDriver.session();
    try {
      const query = `
        CALL custom.getCharacterRelations($bookId, $chapter, $p) 
        YIELD src, tgt, rel, reason, chapter, para
        RETURN src, tgt, rel, reason, chapter, para
      `;

      const result = await session.run(query, { bookId, chapter, p });

      const nodeMap = new Map();
      const edges = [];

      result.records.forEach(record => {
        const src = record.get('src');
        const tgt = record.get('tgt');
        const rel = record.get('rel');
        const reason = record.get('reason');
        const ch = record.get('chapter');
        const pa = record.get('para');

        const paragraphOrder = pa && typeof pa.toNumber === 'function' ? pa.toNumber() : parseInt(pa, 10);

        if (src) {
          if (!nodeMap.has(src)) {
            nodeMap.set(src, {
              id: src,
              name: src,
              role: null
            });
          }
        }

        if (tgt) {
          if (!nodeMap.has(tgt)) {
            nodeMap.set(tgt, {
              id: tgt,
              name: tgt,
              role: null
            });
          }
        }

        if (src && tgt && rel) {
          edges.push({
            id: `${src}-${tgt}-${rel}`,
            source: src,
            target: tgt,
            type: rel,
            relation: reason || null,
            chapter: ch || null,
            start_paragraph_order: paragraphOrder || 0
          });
        }
      });

      logger.info(`[User Graph API] Neo4j 프로시저 조회 성공. 매핑된 노드 수: ${nodeMap.size}개, 관계 수: ${edges.length}개`);

      // PostgreSQL에서 인물 정보 및 사건 역할 조회 (진도 이하의 주요 사건들만 필터링)
      const charQuery = `
        SELECT 
          c.character_id, 
          c.character_name, 
          c.role, 
          ec.event_id, 
          ec.role_in_event,
          e.event_order
        FROM character c
        LEFT JOIN event_character ec ON c.character_id = ec.character_id
        LEFT JOIN event e ON ec.event_id = e.event_id
        LEFT JOIN chapter ch ON e.chapter_id = ch.chapter_id
        LEFT JOIN paragraph p_start ON e.start_paragraph_id = p_start.paragraph_id
        WHERE c.books_id = $1
          AND (
            ec.event_id IS NULL 
            OR (
              e.is_core_event = true
              AND (
                ch.chapter_order < $2::integer
                OR (ch.chapter_order = $2::integer AND p_start.paragraph_order <= $3::integer)
              )
            )
          )
      `;

      const charDbResult = await dbPool.query(charQuery, [bookId, chapter, p]);
      logger.info(`[User Graph API] PostgreSQL 인물 정보 및 사건 역할 조회 성공 (조회 수: ${charDbResult.rows.length}개)`);

      const charMap = new Map();
      charDbResult.rows.forEach(row => {
        const name = row.character_name;
        if (!charMap.has(name)) {
          charMap.set(name, {
            character_id: parseInt(row.character_id, 10),
            role: row.role || null,
            role_in_event: []
          });
        }
        if (row.event_id && row.role_in_event) {
          charMap.get(name).role_in_event.push({
            event_id: parseInt(row.event_id, 10),
            event_order: row.event_order ? parseInt(row.event_order, 10) : null,
            role_in_event: row.role_in_event
          });
        }
      });

      nodeMap.forEach((node, name) => {
        const dbChar = charMap.get(name);
        if (dbChar) {
          node.character_id = dbChar.character_id;
          node.role = dbChar.role;
          node.role_in_event = dbChar.role_in_event;
        } else {
          node.character_id = null;
          node.role_in_event = [];
        }
      });

      const responsePayload = {
        book_id: bookId,
        chapter_limit: chapter,
        paragraph_limit: p,
        nodes: Array.from(nodeMap.values()),
        edges: edges
      };

      return {
        status: 200,
        headers: {
          'Cache-Control': 'public, max-age=86400',
          'X-Cache-Channel': `book-${bookId}-c-${chapter}-p-${p}`,
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

app.http('getEvents', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'books/{bookId}/events',
  handler: async (request, context) => {
    const bookId = parseInt(request.params.bookId, 10);
    const chapterParam = request.query.get('c') || request.query.get('chapter');
    const pParam = request.query.get('p') || request.query.get('para') || request.query.get('paragraph');

    if (isNaN(bookId)) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Bad Request', message: 'bookId 파라미터는 유효한 정수여야 합니다.' })
      };
    }

    // 기본값 설정 (파라미터 누락 시 1)
    const chapter = chapterParam !== null ? parseInt(chapterParam, 10) : 1;
    const p = pParam !== null ? parseInt(pParam, 10) : 1;

    if (isNaN(chapter) || chapter < 1) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Bad Request', message: '챕터 파라미터 c(또는 chapter)는 1 이상의 정수여야 합니다.' })
      };
    }

    if (isNaN(p) || p < 0) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Bad Request', message: '문단 파라미터 p(또는 para)는 0 이상의 정수여야 합니다.' })
      };
    }

    logger.info(`[User Events API] Book ID: ${bookId}, Chapter 진도: ${chapter}, Paragraph 진도: ${p}`);

    try {
      const queryStr = `
        SELECT 
          e.event_id, 
          e.event_order, 
          e.short_title, 
          e.summary,
          ch.chapter_order,
          p_start.paragraph_order AS start_paragraph_order
        FROM event e
        JOIN chapter ch ON e.chapter_id = ch.chapter_id
        JOIN paragraph p_start ON e.start_paragraph_id = p_start.paragraph_id
        WHERE e.books_id = $1
          AND e.is_core_event = true
          AND (
            ch.chapter_order < $2::integer
            OR (ch.chapter_order = $2::integer AND p_start.paragraph_order <= $3::integer)
          )
        ORDER BY ch.chapter_order ASC, e.event_order ASC, e.event_id ASC
      `;

      const result = await dbPool.query(queryStr, [bookId, chapter, p]);
      logger.info(`[User Events API] 사건 목록 조회 성공 (결과 수: ${result.rows.length}개)`);

      const formattedEvents = result.rows.map(row => ({
        event_id: parseInt(row.event_id, 10),
        event_order: row.event_order,
        short_title: row.short_title,
        summary: row.summary || null,
        chapter_order: parseInt(row.chapter_order, 10),
        start_paragraph_order: parseInt(row.start_paragraph_order, 10)
      }));

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: bookId,
          events: formattedEvents
        })
      };
    } catch (err) {
      logger.error(`[User Events API] 조회 오류: ${err.message}`);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal Server Error', message: err.message })
      };
    }
  }
});


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

app.http('getBookSummary', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'books/{bookId}/summary',
  handler: async (request, context) => {
    const bookId = parseInt(request.params.bookId, 10);
    const chapterParam = request.query.get('c') || request.query.get('chapter_id');
    const pParam = request.query.get('p') || request.query.get('end_paragraph_id');

    if (isNaN(bookId)) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Bad Request', message: 'bookId 파라미터는 유효한 정수여야 합니다.' })
      };
    }

    if (!chapterParam || !pParam) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Bad Request', message: 'chapter_id(또는 c)와 end_paragraph_id(또는 p) 파라미터는 필수입니다.' })
      };
    }

    const chapterId = parseInt(chapterParam, 10);
    const endParagraphId = parseInt(pParam, 10);

    if (isNaN(chapterId) || isNaN(endParagraphId)) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Bad Request', message: 'chapter_id와 end_paragraph_id는 정수여야 합니다.' })
      };
    }

    logger.info(`[User Summary API] Book ID: ${bookId}, Chapter ID: ${chapterId}, End Paragraph ID: ${endParagraphId}`);

    try {
      // 1. 입력 시점(chapter_id, end_paragraph_id) 유효성 검증
      const chCheck = await dbPool.query(
        'SELECT 1 FROM readpoint.chapter WHERE chapter_id = $1 AND books_id = $2',
        [chapterId, bookId]
      );
      const pCheck = await dbPool.query(
        'SELECT 1 FROM readpoint.paragraph WHERE paragraph_id = $1 AND books_id = $2',
        [endParagraphId, bookId]
      );

      if (chCheck.rows.length === 0 || pCheck.rows.length === 0) {
        logger.warn(`[User Summary API] 존재하지 않는 독서 시점 요청 - Chapter ID: ${chapterId}, Paragraph ID: ${endParagraphId}`);
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Bad Request',
            message: '제공된 chapter_id 또는 end_paragraph_id가 존재하지 않는 유효하지 않은 시점입니다.'
          })
        };
      }

      // 2. 입력 시점 이하의 가장 최신 core_event 요약 1개 조회
      const queryStr = `
        SELECT 
            ps.summary_3line
        FROM readpoint.progress_summary ps
        WHERE ps.books_id = $1
          AND ps.is_core_event = true
          AND (
            ps.chapter_id < $2
            OR (ps.chapter_id = $2 AND ps.end_paragraph_id <= $3)
          )
        ORDER BY ps.chapter_id DESC, ps.end_paragraph_id DESC
        LIMIT 1;
      `;

      const result = await dbPool.query(queryStr, [bookId, chapterId, endParagraphId]);

      if (result.rows.length === 0) {
        logger.info(`[User Summary API] 해당 시점 이전의 요약이 존재하지 않음 - Book ID: ${bookId}`);
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            summary: null
          })
        };
      }

      logger.info(`[User Summary API] 요약 조회 성공 - Book ID: ${bookId}`);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: result.rows[0].summary_3line
        })
      };
    } catch (err) {
      logger.error(`[User Summary API] 조회 오류: ${err.message}`);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal Server Error', message: err.message })
      };
    }
  }
});
