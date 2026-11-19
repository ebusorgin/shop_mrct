import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { ApiError } from '../http';
import { logSink, type LogKind } from './ws-log';

/** Путь к Qoder CLI: env QODERCLI_BIN, иначе стандартная установка в профиле пользователя. */
export function qoderCliBin(): string {
  const explicit = (process.env.QODERCLI_BIN ?? '').trim();
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    return path.join(home, '.qoder', 'bin', 'qodercli', 'qodercli.exe');
  }
  return 'qodercli';
}

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Версии CLI, в которых потоковый режим отдаёт картинку модели как заглушку
 * «Binary content provided» — «Распознавание» честно отвечает «НЕ НАКЛАДНАЯ».
 * Проверено на проде: 1.1.91–1.1.92 не читают фото ни в одном режиме, 1.1.93 —
 * только в обычном. 1.1.90 работает в обоих.
 */
export const CLI_VERSIONS_WITH_BROKEN_VISION = ['1.1.91', '1.1.92', '1.1.93'];

let cliVersionCache: string | null | undefined;

/** Версия qodercli (кэш на процесс). Нужна в логах: регрессии CLI ломают чтение фото. */
export async function qoderCliVersion(): Promise<string | null> {
  if (cliVersionCache !== undefined) return cliVersionCache;
  const bin = qoderCliBin();
  cliVersionCache = await new Promise<string | null>((resolve) => {
    let out = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ['--version'], { windowsHide: true, env: cliEnv() });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* процесс уже завершился */
      }
      resolve(null);
    }, 10000);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const m = out.match(/\d+\.\d+\.\d+/);
      resolve(m ? m[0] : out.trim().slice(0, 40) || null);
    });
  });
  return cliVersionCache ?? null;
}

/**
 * CRM может работать внутри Qoder (агентский процесс): его SDK-переменные ломают обычный
 * запуск CLI («SDK worker sessions are no longer supported»). Оставляем только токен.
 */
function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (!key.startsWith('QODER_')) continue;
    if (key === 'QODER_PERSONAL_ACCESS_TOKEN' || key === 'QODER_CONFIG_DIR') continue;
    delete env[key];
  }
  // systemd задаёт API лимит heap (--max-old-space-size=384); CLI — отдельный Node-процесс,
  // и с таким лимитом он падает по памяти на большом файле. Ему нужен свой дефолт.
  delete env.NODE_OPTIONS;
  return env;
}

/**
 * Запуск Qoder CLI в неинтерактивном режиме. Агенту разрешено только чтение файлов
 * в рабочей папке — никакой записи, shell и сети сверх модели.
 * `onLine` отдаёт stdout/stderr построчно сразу, не дожидаясь завершения:
 * по stream-json из этого получается живой лог «что делает модель».
 */
export function runQoderCli(
  prompt: string,
  cwd: string,
  timeoutMs = 240000,
  opts: {
    streamJson?: boolean;
    onLine?: (line: string, stream: 'out' | 'err') => void;
    /** Дополнительные аргументы CLI (например, --agent). */
    extraArgs?: string[];
  } = {}
): Promise<CliRun> {  return new Promise((resolve, reject) => {
    const bin = qoderCliBin();
    if (bin.includes(path.sep) && !fs.existsSync(bin)) {
      reject(new ApiError(503, `Сервис ИИ не найден на сервере: ${bin}. Установите CLI или задайте QODERCLI_BIN.`));
      return;
    }
    const args = [
      '--tools', 'Read',
      '--permission-mode', 'dont_ask',
      '--no-session-persistence',
      ...(opts.extraArgs ?? []),
      ...(opts.streamJson ? ['--output-format', 'stream-json'] : []),
      '-p', prompt,
    ];
    const child = spawn(bin, args, { cwd, windowsHide: true, env: cliEnv() });
    let stdout = '';
    let stderr = '';
    let outBuf = '';
    let errBuf = '';
    let timedOut = false;
    const emitLines = (chunk: string, stream: 'out' | 'err'): void => {
      if (!opts.onLine) return;
      if (stream === 'out') outBuf += chunk;
      else errBuf += chunk;
      let buf = stream === 'out' ? outBuf : errBuf;
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        opts.onLine(line, stream);
        nl = buf.indexOf('\n');
      }
      if (stream === 'out') outBuf = buf;
      else errBuf = buf;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (stdout.length > 4_000_000) stdout = stdout.slice(-4_000_000);
      emitLines(text, 'out');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      if (stderr.length > 400_000) stderr = stderr.slice(-400_000);
      emitLines(text, 'err');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new ApiError(502, `Не удалось запустить сервис ИИ: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (outBuf.trim()) opts.onLine?.(outBuf, 'out');
      if (errBuf.trim()) opts.onLine?.(errBuf, 'err');
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** ANSI-цвета из stderr CLI в лог не нужны. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export interface CliChatter {
  model: string | null;
  answer: string[];
  final: string | null;
  durationMs: number | null;
}

/**
 * Одна строка stream-json от CLI -> человеческие события лога.
 * Виды: thinking (рассуждения модели), tool_use (что читает/вызывает),
 * text (итоговый ответ), result (служебный итог запуска).
 */
export function consumeCliLine(
  line: string,
  state: CliChatter,
  log: (kind: LogKind, text: string) => void
): void {
  const clean = stripAnsi(line).trim();
  if (!clean) return;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(clean) as Record<string, unknown>;
  } catch {
    log('stage', clean.slice(0, 600));
    return;
  }
  const msg = j.message as { content?: unknown[] } | undefined;
  const content = Array.isArray(msg?.content) ? (msg!.content as Record<string, unknown>[]) : [];
  if (j.type === 'system' && j.subtype === 'init') {
    state.model = typeof j.model === 'string' ? j.model : null;
    log('stage', `ИИ готов · модель ${state.model ?? 'Auto'}`);
    return;
  }
  if (j.type === 'assistant') {
    for (const c of content) {
      if (c.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim()) {
        log('thinking', c.thinking);
      } else if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        state.answer.push(c.text);
        log('stage', 'Модель написала текст — смотрю дальше');
      } else if (c.type === 'tool_use') {
        const name = String(c.name ?? 'инструмент');
        const input = (c.input ?? {}) as Record<string, unknown>;
        const file = typeof input.file_path === 'string' ? path.basename(input.file_path) : '';
        if (name === 'Read') log('tool', `Читаю файл ${file || 'накладной'}`);
        else log('tool', `Инструмент: ${name}${file ? ` (${file})` : ''}`);
      }
    }
    return;
  }
  if (j.type === 'user') {
    const results = content.filter((c) => c.type === 'tool_result');
    if (results.length) {
      const hasImage = results.some(
        (c) => Array.isArray(c.content) && (c.content as Record<string, unknown>[]).some((b) => b?.type === 'image')
      );
      const binaryStub = results.some(
        (c) => typeof c.content === 'string' && /binary content provided/i.test(c.content)
      );
      if (binaryStub && !hasImage) {
        // CLI 1.1.91+ в потоковом режиме отдаёт модели заглушку вместо картинки:
        // без этого сообщения разбор выглядит как «плохое фото», а виновата версия CLI.
        log('error', 'CLI передал фото модели как текст, а не изображение — модель его не видит (проверьте версию qodercli: рабочая 1.1.90)');
      } else {
        log('tool', 'Инструмент ответил — продолжаю');
      }
    }
    return;
  }
  if (j.type === 'result') {
    state.durationMs = typeof j.duration_ms === 'number' ? j.duration_ms : null;
    if (typeof j.result === 'string' && j.result.trim()) state.final = j.result.trim();
    if (j.is_error === true) log('error', String(j.result ?? 'ИИ вернул ошибку').slice(0, 1000));
    return;
  }
}

/**
 * Достать JSON из ответа агента. CLI печатает ответ внутри XML-обёртки `<response>`,
 * может добавлять ANSI-цвета и пояснения до/после объекта — поэтому ищем не первую
 * и последнюю скобку, а каждый сбалансированный объект верхнего уровня.
 */
export function extractCliJson(text: string): Record<string, unknown> {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!clean) throw new ApiError(502, 'Qoder CLI не вернул JSON с распознанной накладной');

  const candidates: Record<string, unknown>[] = [];
  for (let start = clean.indexOf('{'); start >= 0; start = clean.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < clean.length; i++) {
      const ch = clean[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(clean.slice(start, i + 1)) as Record<string, unknown>;
            if (obj && typeof obj === 'object') candidates.push(obj);
          } catch {
            /* не JSON — пробуем следующую скобку */
          }
          break;
        }
      }
    }
    if (candidates.length) break;
  }

  const parsed = candidates.find((o) => Array.isArray(o.items)) ?? candidates[0];
  if (!parsed) {
    const tail = clean.replace(/\s+/g, ' ').slice(-400);
    throw new ApiError(502, `Qoder CLI не вернул JSON с накладной. Ответ CLI: ${tail}`);
  }
  return parsed;
}

/** Один запуск CLI с живым логом: собирает ответ и служебные события. */
export async function runCliLogged(
  prompt: string,
  cwd: string,
  log: (kind: LogKind, text: string) => void,
  opts: { timeoutMs?: number; extraArgs?: string[]; streamJson?: boolean } = {}
): Promise<{ text: string; model: string | null; durationMs: number | null; run: CliRun }> {
  const state: CliChatter = { model: null, answer: [], final: null, durationMs: null };
  const onLine = (line: string, stream: 'out' | 'err'): void => {
    if (stream === 'err') {
      const clean = stripAnsi(line).trim();
      if (clean) log('stage', `CLI: ${clean.slice(0, 600)}`);
      return;
    }
    consumeCliLine(line, state, log);
  };
  const streamJson = opts.streamJson !== false;
  let run = await runQoderCli(prompt, cwd, opts.timeoutMs ?? 240000, {
    streamJson,
    onLine,
    extraArgs: opts.extraArgs,
  });
  // Старая версия CLI может не знать stream-json: тогда повторяем обычным запуском.
  if (streamJson && run.code !== 0 && /output-format|unknown option|invalid.*format/i.test(stripAnsi(run.stderr + run.stdout))) {
    log('stage', 'CLI не поддерживает потоковый режим — повторяю обычным запуском');
    state.answer = [];
    state.final = null;
    state.durationMs = null;
    state.model = null;
    run = await runQoderCli(prompt, cwd, opts.timeoutMs ?? 240000, { onLine, extraArgs: opts.extraArgs });
  }
  if (run.timedOut) {
    const minutes = Math.round((opts.timeoutMs ?? 240000) / 60000);
    throw new ApiError(504, `Qoder CLI не ответил за ${minutes} мин — попробуйте один лист или повторите позже`);
  }
  if (run.code !== 0) {
    const detail = (run.stderr || run.stdout).trim().slice(-800);
    if (/not logged in|login required|авториз/i.test(detail)) {
      throw new ApiError(502, 'Qoder CLI не авторизован на сервере — выполните «qodercli login» и повторите');
    }
    throw new ApiError(502, `Qoder CLI завершился с ошибкой${detail ? `: ${detail}` : ''}`);
  }
  const text = state.answer.join('\n').trim() || state.final || run.stdout;
  return { text, model: state.model, durationMs: state.durationMs, run };
}

/** Создать логгер для конкретной задачи (обёртка над logSink). */
export function jobLogger(userId: number | undefined, jobId: string): (kind: LogKind, text: string) => void {
  return logSink(userId, jobId);
}
