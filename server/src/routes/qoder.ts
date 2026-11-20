/**
 * Чат с Qoder — вкладка настроек (только администратор).
 *
 * Каждый диалог принадлежит пользователю: список, продолжение и удаление
 * проверяют user_id, поэтому чужая переписка недоступна даже по id.
 * Ответ генерирует Qoder CLI в папке проекта с полным набором инструментов:
 * вопрос запускает фоновую задачу, а команды, требующие разрешения, администратор
 * подтверждает прямо в чате.
 */
import { Router } from 'express';
import { pool, tx } from '../db';
import { ApiError, reqStr, wrap } from '../http';
import { stripAnsi } from '../services/qoder-cli';
import { qoderAgent, qoderProjectRoot, type QoderApprovalDecision } from '../services/qoder-agent';

export const qoderRouter = Router();

/** Сколько последних сообщений диалога отдаём модели и сколько символов берём из каждого. */
const HISTORY_LIMIT = 20;
const MESSAGE_CHARS = 4000;
const PROMPT_CHARS = 24000;
const ANSWER_LIMIT = 20000;

function systemPrompt(): string {
  return (
    'Ты — Qoder, ИИ-агент проекта CRM MIX markt (склад, накладные, рецептуры, заказы, магазины). ' +
    `Рабочая папка проекта: ${qoderProjectRoot()}. ` +
    'У тебя полный доступ к проекту, как в Qoder Desktop: читай и правь файлы, ищи код, запускай команды и тесты. ' +
    'Не используй инструменты AskUserQuestion, EnterPlanMode, ExitPlanMode, EnterWorktree и ExitWorktree — ' +
    'в веб-чате для них нет интерфейса; уточняющие вопросы задавай обычным текстом и завершай ход. ' +
    'Опасные и необратимые действия (удаление файлов, git push, миграции и правки прод-базы, перезапуск сервисов, деплой) ' +
    'выполняй только по явной просьбе пользователя; каждое такое действие он подтверждает в окне разрешения. ' +
    'Отвечай по-русски, кратко и по делу. В конце перечисли, что сделал и как проверил.'
  );
}

interface HistoryRow {
  role: string;
  content: string;
}

/** Собирает промпт: установка агента + последние сообщения + новый вопрос. */
export function chatPrompt(history: HistoryRow[], question: string): string {
  const lines: string[] = [systemPrompt(), '', 'Диалог:'];
  let budget = PROMPT_CHARS;
  const tail: string[] = [];
  for (let i = history.length - 1; i >= 0 && tail.length < HISTORY_LIMIT; i--) {
    const role = history[i].role === 'assistant' ? 'Qoder' : 'Пользователь';
    const text = String(history[i].content).slice(0, MESSAGE_CHARS);
    if (text.length > budget) break;
    budget -= text.length;
    tail.unshift(`${role}: ${text}`);
  }
  lines.push(...tail);
  lines.push(`Пользователь: ${question}`, '', 'Ответь на последнее сообщение пользователя.');
  return lines.join('\n');
}

/** CLI иногда оборачивает ответ в <response> или добавляет ANSI — в БД это не нужно. */
function cleanAnswer(raw: string): string {
  let text = stripAnsi(raw).trim();
  const wrapped = text.match(/<response>([\s\S]*?)<\/response>/i);
  if (wrapped) text = wrapped[1].trim();
  return text.slice(0, ANSWER_LIMIT);
}

async function ownDialog(userId: number, rawId: string): Promise<{ id: number; title: string }> {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'Некорректный идентификатор диалога');
  const { rows } = await pool.query('select id, title from qoder_dialogs where id = $1 and user_id = $2', [id, userId]);
  if (!rows.length) throw new ApiError(404, 'Диалог не найден');
  return rows[0] as { id: number; title: string };
}

qoderRouter.get(
  '/dialogs',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `select d.id, d.title,
              to_char(d.updated_at, 'DD.MM.YYYY HH24:MI') as "updatedAt",
              (select count(*) from qoder_messages m where m.dialog_id = d.id)::int as "messageCount",
              (select left(m.content, 160) from qoder_messages m where m.dialog_id = d.id order by m.id desc limit 1) as "preview"
         from qoder_dialogs d
        where d.user_id = $1
        order by d.updated_at desc, d.id desc`,
      [req.user!.id]
    );
    res.json(rows);
  })
);

qoderRouter.post(
  '/dialogs',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `insert into qoder_dialogs (user_id) values ($1)
       returning id, title, to_char(updated_at, 'DD.MM.YYYY HH24:MI') as "updatedAt", 0 as "messageCount", null as preview`,
      [req.user!.id]
    );
    res.status(201).json(rows[0]);
  })
);

qoderRouter.get(
  '/dialogs/:id',
  wrap(async (req, res) => {
    const dialog = await ownDialog(req.user!.id, req.params.id);
    const { rows: messages } = await pool.query(
      `select id, role, content, to_char(created_at, 'DD.MM.YYYY HH24:MI') as "createdAt"
         from qoder_messages where dialog_id = $1 order by id`,
      [dialog.id]
    );
    res.json({ ...dialog, messages });
  })
);

/** Активная задача диалога: по ней чат продолжает показывать ход работы после перезагрузки. */
qoderRouter.get(
  '/dialogs/:id/job',
  wrap(async (req, res) => {
    const dialog = await ownDialog(req.user!.id, req.params.id);
    res.json({ job: qoderAgent.activeForDialog(dialog.id, req.user!.id) });
  })
);

qoderRouter.delete(
  '/dialogs/:id',
  wrap(async (req, res) => {
    const dialog = await ownDialog(req.user!.id, req.params.id);
    qoderAgent.cancelForDialog(dialog.id, req.user!.id);
    await pool.query('delete from qoder_dialogs where id = $1', [dialog.id]);
    res.json({ ok: true });
  })
);

qoderRouter.post(
  '/dialogs/:id/messages',
  wrap(async (req, res) => {
    const dialog = await ownDialog(req.user!.id, req.params.id);
    const text = reqStr(req.body ?? {}, 'text');
    if (text.length > MESSAGE_CHARS) throw new ApiError(400, `Сообщение длиннее ${MESSAGE_CHARS} символов`);
    const { rows: history } = await pool.query(
      `select role, content from qoder_messages where dialog_id = $1 order by id desc limit ${HISTORY_LIMIT}`,
      [dialog.id]
    );
    history.reverse();

    const saved = await tx(async (c) => {
      const { rows: count } = await c.query('select count(*)::int as n from qoder_messages where dialog_id = $1', [
        dialog.id,
      ]);
      const first = count[0].n === 0;
      const { rows: userRow } = await c.query(
        `insert into qoder_messages (dialog_id, role, content) values ($1, 'user', $2)
         returning id, role, content, to_char(created_at, 'DD.MM.YYYY HH24:MI') as "createdAt"`,
        [dialog.id, text]
      );
      // Заголовок диалога — начало первого вопроса; дальше человек узнаёт его по списку.
      const title = first ? text.replace(/\s+/g, ' ').slice(0, 60) : dialog.title;
      await c.query('update qoder_dialogs set updated_at = now(), title = $2 where id = $1', [dialog.id, title]);
      return { userMessage: userRow[0], title, first };
    });

    try {
      const job = qoderAgent.start({
        userId: req.user!.id,
        dialogId: dialog.id,
        prompt: chatPrompt(history, text),
        title: saved.title,
        onFinish: async (answer) => {
          const clean = cleanAnswer(answer);
          if (!clean) throw new Error('пустой ответ');
          const { rows } = await pool.query(
            `insert into qoder_messages (dialog_id, role, content) values ($1, 'assistant', $2)
             returning id, role, content, to_char(created_at, 'DD.MM.YYYY HH24:MI') as "createdAt"`,
            [dialog.id, clean]
          );
          await pool.query('update qoder_dialogs set updated_at = now() where id = $1', [dialog.id]);
          return rows[0];
        },
      });
      res.status(202).json({ jobId: job.id, userMessage: saved.userMessage, title: saved.title });
    } catch (error) {
      // Задача не стартовала — не оставляем в истории вопрос без ответа.
      await pool.query('delete from qoder_messages where id = $1', [saved.userMessage.id]).catch(() => undefined);
      if (saved.first) {
        await pool.query('update qoder_dialogs set title = $2 where id = $1', [dialog.id, dialog.title]).catch(() => undefined);
      }
      throw error;
    }
  })
);

qoderRouter.get(
  '/jobs/:id',
  wrap(async (req, res) => {
    res.json(qoderAgent.get(req.params.id, req.user!.id));
  })
);

qoderRouter.post(
  '/jobs/:id/approvals/:approvalId',
  wrap(async (req, res) => {
    const raw = String((req.body ?? {}).decision ?? '');
    if (raw !== 'once' && raw !== 'always' && raw !== 'deny') {
      throw new ApiError(400, 'decision должен быть once, always или deny');
    }
    res.json(qoderAgent.approve(req.params.id, req.user!.id, req.params.approvalId, raw as QoderApprovalDecision));
  })
);

qoderRouter.post(
  '/jobs/:id/cancel',
  wrap(async (req, res) => {
    res.json(qoderAgent.cancel(req.params.id, req.user!.id));
  })
);
