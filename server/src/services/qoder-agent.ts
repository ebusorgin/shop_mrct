/**
 * Фоновые задачи Qoder для веб-чата.
 *
 * CLI запускается в папке проекта с полным набором инструментов, как десктопная версия.
 * Каждое действие, требующее разрешения, приходит по stream-json как can_use_tool;
 * администратор подтверждает его в чате, а сервер отвечает CLI по stdin.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ApiError } from '../http';
import { cliEnv, qoderCliBin, stripAnsi } from './qoder-cli';

const PROJECT_ROOT = (process.env.QODER_CHAT_CWD ?? '').trim() || '/opt/mixmarkt-crm/src';
const TIMEOUT_MS = Math.max(60_000, Number(process.env.QODER_CHAT_TIMEOUT_MS) || 30 * 60_000);
const JOB_TTL_MS = 60 * 60_000;
const MAX_EVENTS = 400;
const MAX_EVENT_DETAIL = 4000;
const MAX_APPROVAL_PREVIEW = 2500;
const MAX_JOBS_PER_USER = 2;
const MAX_ANSWER = 20000;

export type QoderJobStatus = 'running' | 'done' | 'error' | 'cancelled';
export type QoderApprovalDecision = 'once' | 'always' | 'deny';

export interface QoderJobEvent {
  seq: number;
  at: string;
  kind: 'tool' | 'tool_result' | 'status' | 'error' | 'text' | 'thinking';
  title: string;
  detail?: string;
  tool?: string;
  toolUseId?: string;
  status?: 'running' | 'ok' | 'error';
  permissionId?: string;
}

export interface QoderApproval {
  id: string;
  tool: string;
  title: string;
  description?: string;
  preview: string;
  canAlways: boolean;
  createdAt: string;
  resolved?: QoderApprovalDecision;
}

export interface QoderJobSnapshot {
  id: string;
  status: QoderJobStatus;
  events: QoderJobEvent[];
  approvals: QoderApproval[];
  answer?: string;
  error?: string;
  assistantMessage?: unknown;
  title?: string;
}

export interface StartQoderJobInput {
  userId: number;
  dialogId: number;
  prompt: string;
  title: string;
  onFinish: (answer: string) => Promise<unknown>;
}

interface InternalApproval extends QoderApproval {
  suggestions: unknown[];
}

interface Job {
  id: string;
  userId: number;
  dialogId: number;
  title: string;
  status: QoderJobStatus;
  events: QoderJobEvent[];
  approvals: InternalApproval[];
  answer?: string;
  error?: string;
  assistantMessage?: unknown;
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  finishedAt?: number;
  seq: number;
  finishing: boolean;
  stderr: string;
  textParts: string[];
  toolNames: Map<string, string>;
  /** CLI отдаёт потоковые дельты: текст и мысли показываем по мере генерации. */
  streaming: boolean;
  streamBlocks: Map<number, QoderJobEvent>;
  onFinish: (answer: string) => Promise<unknown>;
  timeout?: NodeJS.Timeout;
  keepAlive?: NodeJS.Timeout;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function qoderProjectRoot(): string {
  return PROJECT_ROOT;
}

class QoderAgentService {
  private jobs = new Map<string, Job>();
  private byDialog = new Map<number, string>();

  start(input: StartQoderJobInput): QoderJobSnapshot {
    const active = this.byDialog.get(input.dialogId);
    if (active && this.jobs.get(active)?.status === 'running') {
      throw new ApiError(409, 'Qoder ещё выполняет предыдущий запрос в этом диалоге');
    }
    const running = [...this.jobs.values()].filter((j) => j.userId === input.userId && j.status === 'running').length;
    if (running >= MAX_JOBS_PER_USER) {
      throw new ApiError(429, `Слишком много одновременных задач Qoder (не больше ${MAX_JOBS_PER_USER})`);
    }
    const bin = qoderCliBin();
    if (bin.includes(path.sep) && !fs.existsSync(bin)) {
      throw new ApiError(503, `Сервис ИИ не найден на сервере: ${bin}. Установите CLI или задайте QODERCLI_BIN.`);
    }

    const id = randomUUID();
    const args = [
      '-w', PROJECT_ROOT,
      '--tools', 'default',
      '--permission-mode', 'default',
      '--permission-prompt-tool', 'stdio',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--no-session-persistence',
      // adaptive: модель сама решает, думать ли; если думает — мысли идут в ленту чата.
      '--thinking', 'adaptive',
      '-p', input.prompt,
    ];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, args, {
        cwd: PROJECT_ROOT,
        env: cliEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      throw new ApiError(503, `Не удалось запустить Qoder CLI: ${errorText(error)}`);
    }

    const job: Job = {
      id,
      userId: input.userId,
      dialogId: input.dialogId,
      title: input.title,
      status: 'running',
      events: [],
      approvals: [],
      child,
      startedAt: Date.now(),
      seq: 0,
      finishing: false,
      stderr: '',
      textParts: [],
      toolNames: new Map(),
      streaming: false,
      streamBlocks: new Map(),
      onFinish: input.onFinish,
    };
    this.jobs.set(id, job);
    this.byDialog.set(job.dialogId, id);
    this.addEvent(job, 'status', `Qoder запущен в проекте: ${PROJECT_ROOT}`);
    this.bind(job);
    job.timeout = setTimeout(() => {
      this.fail(job, `Qoder не уложился в ${Math.round(TIMEOUT_MS / 60_000)} мин — задача остановлена`);
    }, TIMEOUT_MS);
    job.timeout.unref();
    job.keepAlive = setInterval(() => this.write(job, { type: 'keep_alive' }), 60_000);
    job.keepAlive.unref();
    return this.snapshot(job);
  }

  get(jobId: string, userId: number): QoderJobSnapshot {
    return this.snapshot(this.own(jobId, userId));
  }

  activeForDialog(dialogId: number, userId: number): QoderJobSnapshot | null {
    const id = this.byDialog.get(dialogId);
    const job = id ? this.jobs.get(id) : undefined;
    if (!job || job.userId !== userId) return null;
    return job.status === 'running' ? this.snapshot(job) : null;
  }

  approve(jobId: string, userId: number, approvalId: string, decision: QoderApprovalDecision): QoderJobSnapshot {
    const job = this.own(jobId, userId);
    if (job.status !== 'running') throw new ApiError(409, 'Задача Qoder уже завершена');
    const approval = job.approvals.find((a) => a.id === approvalId);
    if (!approval) throw new ApiError(404, 'Запрос на подтверждение не найден');
    if (approval.resolved) throw new ApiError(409, 'Это действие уже подтверждено или отклонено');

    let response: Record<string, unknown>;
    if (decision === 'deny') {
      response = { behavior: 'deny', message: 'Пользователь отклонил действие в веб-чате' };
    } else if (decision === 'always' && approval.suggestions.length) {
      response = {
        behavior: 'allow',
        permissionScope: 'persist',
        updatedPermissions: approval.suggestions,
      };
    } else {
      response = { behavior: 'allow', permissionScope: 'once' };
    }
    const sent = this.write(job, {
      type: 'control_response',
      response: { subtype: 'success', request_id: approval.id, response },
    });
    if (!sent) throw new ApiError(409, 'Не удалось отправить подтверждение — Qoder уже завершил задачу');

    approval.resolved = decision;
    this.addEvent(
      job,
      'status',
      decision === 'deny'
        ? `Отклонено: ${approval.title}`
        : decision === 'always'
          ? `Разрешено и запомнено: ${approval.title}`
          : `Разрешено: ${approval.title}`
    );
    return this.snapshot(job);
  }

  cancel(jobId: string, userId: number): QoderJobSnapshot {
    const job = this.own(jobId, userId);
    if (job.status !== 'running') return this.snapshot(job);
    job.finishing = true;
    job.status = 'cancelled';
    job.error = 'Задача остановлена пользователем';
    job.finishedAt = Date.now();
    this.addEvent(job, 'status', 'Задача остановлена пользователем');
    this.cleanup(job);
    try {
      job.child.kill('SIGKILL');
    } catch {
      /* процесс уже завершился */
    }
    return this.snapshot(job);
  }

  /** Останавливает задачу диалога перед удалением диалога. */
  cancelForDialog(dialogId: number, userId: number): void {
    const id = this.byDialog.get(dialogId);
    if (id) {
      const job = this.jobs.get(id);
      if (job && job.userId === userId && job.status === 'running') this.cancel(id, userId);
    }
  }

  private own(jobId: string, userId: number): Job {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) throw new ApiError(404, 'Задача Qoder не найдена');
    return job;
  }

  private bind(job: Job): void {
    job.child.stdout.setEncoding('utf8');
    let buffer = '';
    job.child.stdout.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) this.handleLine(job, line);
      }
      if (buffer.length > 4_000_000) {
        this.addEvent(job, 'error', 'Слишком большой ответ CLI — поток обрезан');
        buffer = '';
      }
    });

    job.child.stderr.setEncoding('utf8');
    job.child.stderr.on('data', (chunk: Buffer | string) => {
      job.stderr = (job.stderr + chunk.toString()).slice(-8000);
    });

    job.child.stdin.on('error', () => {
      /* Qoder мог закрыть stdin раньше — ответ всё равно придёт в stdout */
    });

    job.child.on('error', (error) => {
      this.fail(job, `Не удалось запустить Qoder CLI: ${error.message}`);
    });

    job.child.on('close', () => {
      if (job.keepAlive) clearInterval(job.keepAlive);
      if (job.timeout) clearTimeout(job.timeout);
      job.keepAlive = undefined;
      job.timeout = undefined;
      if (job.status === 'running' && !job.finishing) {
        this.fail(job, job.stderr.trim() || 'Qoder завершился без ответа', false);
      }
      this.pruneLater(job);
    });
  }

  private handleLine(job: Job, line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      const record = asRecord(parsed);
      if (!record) return;
      message = record;
    } catch {
      return;
    }

    switch (asString(message.type)) {
      case 'system':
        this.handleSystem(job, message);
        break;
      case 'stream_event':
        this.handleStreamEvent(job, asRecord(message.event));
        break;
      case 'assistant':
        this.handleAssistant(job, asRecord(message.message));
        break;
      case 'user':
        this.handleToolResults(job, asRecord(message.message));
        break;
      case 'control_request':
        this.handleControlRequest(job, message);
        break;
      case 'result':
        this.handleResult(job, message);
        break;
      default:
        break;
    }
  }

  private handleSystem(job: Job, message: Record<string, unknown>): void {
    if (asString(message.subtype) !== 'init') return;
    const model = asString(message.model) || 'Auto';
    const tools = Array.isArray(message.tools) ? message.tools.length : 0;
    this.addEvent(job, 'status', `Модель ${model} · инструментов ${tools}`);
  }

  /** Потоковые дельты: «Qoder пишет» и «Qoder думает» видны сразу, без ожидания хода. */
  private handleStreamEvent(job: Job, event: Record<string, unknown> | null): void {
    if (!event) return;
    job.streaming = true;
    const type = asString(event.type);
    const index = typeof event.index === 'number' ? event.index : -1;
    if (type === 'message_start') {
      job.streamBlocks.clear();
      return;
    }
    if (type === 'content_block_start') {
      const block = asRecord(event.content_block);
      const blockType = asString(block?.type);
      if (blockType !== 'text' && blockType !== 'thinking') return;
      const live = this.addEvent(job, blockType === 'text' ? 'text' : 'thinking', '');
      if (index >= 0) job.streamBlocks.set(index, live);
      return;
    }
    if (type === 'content_block_delta') {
      const delta = asRecord(event.delta);
      const deltaType = asString(delta?.type);
      const live = job.streamBlocks.get(index);
      if (!live) return;
      if (deltaType === 'text_delta' && live.kind === 'text') {
        this.appendEventDetail(live, asString(delta?.text));
      } else if (deltaType === 'thinking_delta' && live.kind === 'thinking') {
        this.appendEventDetail(live, asString(delta?.thinking));
      }
      return;
    }
    if (type === 'content_block_stop') {
      const live = job.streamBlocks.get(index);
      if (live) job.streamBlocks.delete(index);
    }
  }

  private handleAssistant(job: Job, message: Record<string, unknown> | null): void {
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = asRecord(raw);
      if (!block) continue;
      const blockType = asString(block.type);
      if (blockType === 'text') {
        const text = asString(block.text);
        if (text.trim()) {
          job.textParts.push(text);
          // Без потокового режима (старый CLI) показываем текст хотя бы по завершении блока.
          if (!job.streaming) this.addEvent(job, 'text', '', { detail: text });
        }
        continue;
      }
      if (blockType === 'thinking') {
        const thinking = asString(block.thinking);
        if (thinking.trim() && !job.streaming) this.addEvent(job, 'thinking', '', { detail: thinking });
        continue;
      }
      if (blockType !== 'tool_use') continue;
      const tool = asString(block.name) || 'Tool';
      const toolUseId = asString(block.id);
      const input = asRecord(block.input) ?? {};
      if (toolUseId) job.toolNames.set(toolUseId, tool);
      this.addEvent(job, 'tool', toolTitle(tool, input), {
        tool,
        toolUseId: toolUseId || undefined,
        detail: previewOf(input, MAX_EVENT_DETAIL),
        status: 'running',
      });
    }
  }

  private handleToolResults(job: Job, message: Record<string, unknown> | null): void {
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = asRecord(raw);
      if (!block || asString(block.type) !== 'tool_result') continue;
      const toolUseId = asString(block.tool_use_id);
      const tool = job.toolNames.get(toolUseId) || 'Инструмент';
      const failed = block.is_error === true;
      this.addEvent(job, 'tool_result', `${tool}: результат`, {
        tool,
        toolUseId: toolUseId || undefined,
        detail: toolResultText(block.content),
        status: failed ? 'error' : 'ok',
      });
    }
  }

  private handleControlRequest(job: Job, message: Record<string, unknown>): void {
    const request = asRecord(message.request);
    if (!request || asString(request.subtype) !== 'can_use_tool') return;
    const id = asString(message.request_id);
    if (!id || job.approvals.some((a) => a.id === id)) return;
    const tool = asString(request.tool_name) || 'Tool';
    const input = asRecord(request.input) ?? {};
    const details = asRecord(request.details);
    const suggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
    const title = asString(request.title) || asString(details?.title) || toolTitle(tool, input);
    const diff = asString(details?.diff);
    const approval: InternalApproval = {
      id,
      tool,
      title,
      description: asString(request.description) || undefined,
      // Diff правки понятнее JSON-инпута: человек видит, что именно изменится.
      preview: (diff ? diff : previewOf(input, MAX_APPROVAL_PREVIEW)).slice(0, MAX_APPROVAL_PREVIEW),
      canAlways: suggestions.length > 0,
      createdAt: new Date().toISOString(),
      suggestions,
    };
    job.approvals.push(approval);
    this.addEvent(job, 'status', `Требуется подтверждение: ${title}`, {
      tool,
      toolUseId: asString(request.tool_use_id) || undefined,
      permissionId: id,
      detail: approval.description,
    });
  }

  private handleResult(job: Job, message: Record<string, unknown>): void {
    if (job.finishing) return;
    job.finishing = true;
    const raw = asString(message.result);
    const failed = message.is_error === true || (asString(message.subtype) !== '' && asString(message.subtype) !== 'success');
    const answer = (raw || job.textParts.join('\n\n')).trim().slice(0, MAX_ANSWER);
    if (failed) {
      this.fail(job, answer || 'Qoder вернул ошибку', true);
      return;
    }
    if (!answer) {
      this.fail(job, 'Qoder не вернул ответ — попробуйте ещё раз', true);
      return;
    }
    const clean = stripAnsi(answer).trim();
    job.onFinish(clean).then(
      (saved) => {
        job.answer = clean;
        job.assistantMessage = saved;
        job.status = 'done';
        job.finishedAt = Date.now();
        this.addEvent(job, 'status', 'Готово');
        this.endChild(job);
        this.pruneLater(job);
      },
      (error) => {
        job.answer = clean;
        job.status = 'error';
        job.error = `Ответ получен, но не удалось сохранить его в истории: ${errorText(error)}`;
        job.finishedAt = Date.now();
        this.endChild(job);
        this.pruneLater(job);
      }
    );
  }

  private fail(job: Job, message: string, kill = true): void {
    if (job.status !== 'running') return;
    job.finishing = true;
    job.status = 'error';
    job.error = message;
    job.finishedAt = Date.now();
    this.addEvent(job, 'error', message);
    this.cleanup(job);
    if (kill) this.endChild(job);
    this.pruneLater(job);
  }

  private endChild(job: Job): void {
    if (job.keepAlive) clearInterval(job.keepAlive);
    if (job.timeout) clearTimeout(job.timeout);
    job.keepAlive = undefined;
    job.timeout = undefined;
    this.cleanup(job);
    try {
      job.child.stdin.end();
    } catch {
      /* stdin уже закрыт */
    }
    const kill = setTimeout(() => {
      try {
        job.child.kill('SIGKILL');
      } catch {
        /* процесс уже завершился */
      }
    }, 3000);
    kill.unref();
  }

  private cleanup(job: Job): void {
    if (this.byDialog.get(job.dialogId) === job.id) this.byDialog.delete(job.dialogId);
    if (job.keepAlive) clearInterval(job.keepAlive);
    if (job.timeout) clearTimeout(job.timeout);
    job.keepAlive = undefined;
    job.timeout = undefined;
  }

  private pruneLater(job: Job): void {
    const timer = setTimeout(() => this.jobs.delete(job.id), JOB_TTL_MS);
    timer.unref();
  }

  private write(job: Job, frame: unknown): boolean {
    if (job.child.stdin.destroyed || !job.child.stdin.writable) return false;
    try {
      job.child.stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private addEvent(
    job: Job,
    kind: QoderJobEvent['kind'],
    title: string,
    extra: Partial<Pick<QoderJobEvent, 'detail' | 'tool' | 'toolUseId' | 'status' | 'permissionId'>> = {}
  ): QoderJobEvent {
    const event: QoderJobEvent = {
      seq: ++job.seq,
      at: new Date().toISOString(),
      kind,
      title: title.slice(0, 300),
      ...(extra.detail ? { detail: extra.detail.slice(0, MAX_EVENT_DETAIL) } : {}),
      ...(extra.tool ? { tool: extra.tool } : {}),
      ...(extra.toolUseId ? { toolUseId: extra.toolUseId } : {}),
      ...(extra.status ? { status: extra.status } : {}),
      ...(extra.permissionId ? { permissionId: extra.permissionId } : {}),
    };
    job.events.push(event);
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    return event;
  }

  /** Потоковые дельты дописываются в то же событие — в чате растёт один блок, а не сотни строк. */
  private appendEventDetail(event: QoderJobEvent, delta: string): void {
    if (!delta) return;
    const current = event.detail ?? '';
    if (current.length >= MAX_EVENT_DETAIL) return;
    event.detail = (current + delta).slice(0, MAX_EVENT_DETAIL);
  }

  private snapshot(job: Job): QoderJobSnapshot {
    return {
      id: job.id,
      status: job.status,
      events: job.events,
      approvals: job.approvals.map((a) => ({
        id: a.id,
        tool: a.tool,
        title: a.title,
        description: a.description,
        preview: a.preview,
        canAlways: a.canAlways,
        createdAt: a.createdAt,
        resolved: a.resolved,
      })),
      ...(job.answer ? { answer: job.answer } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.assistantMessage ? { assistantMessage: job.assistantMessage } : {}),
      title: job.title,
    };
  }
}

function toolTitle(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') {
    const command = asString(input.command) || asString(input.cmd);
    if (command) return command.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  const file = asString(input.file_path) || asString(input.path);
  if (file) return `${tool}: ${file}`;
  const description = asString(input.description);
  if (description) return `${tool}: ${description}`;
  const url = asString(input.url);
  if (url) return `${tool}: ${url}`;
  return tool;
}

function previewOf(value: unknown, limit: number): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? '';
    } catch {
      text = String(value);
    }
  }
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, MAX_EVENT_DETAIL);
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (typeof item === 'string') return item;
        const block = asRecord(item);
        if (!block) return '';
        if (asString(block.type) === 'text') return asString(block.text);
        return `[${asString(block.type) || 'данные'}]`;
      })
      .filter(Boolean)
      .join('\n');
    return text.slice(0, MAX_EVENT_DETAIL);
  }
  return previewOf(content, MAX_EVENT_DETAIL);
}

export const qoderAgent = new QoderAgentService();
