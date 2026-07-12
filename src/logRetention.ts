export interface RetentionMessage {
  id: string;
  createdTimestamp: number;
  delete(): Promise<unknown>;
}

interface TimerHandle {
  unref?: () => unknown;
}

export interface LogRetentionManagerOptions {
  retentionMs: number;
  retryDelayMs?: number;
  maxTimerDelayMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  markAutomaticDelete?: (messageId: string) => void;
  unmarkAutomaticDelete?: (messageId: string) => void;
  isMissingMessageError?: (error: unknown) => boolean;
  onDeleteError?: (messageId: string, error: unknown) => void;
}

const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_MAX_TIMER_DELAY_MS = 2_147_483_647;

export class LogRetentionManager {
  private readonly timers = new Map<string, TimerHandle>();
  private readonly retentionMs: number;
  private readonly retryDelayMs: number;
  private readonly maxTimerDelayMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly markAutomaticDelete: (messageId: string) => void;
  private readonly unmarkAutomaticDelete: (messageId: string) => void;
  private readonly isMissingMessageError: (error: unknown) => boolean;
  private readonly onDeleteError: (messageId: string, error: unknown) => void;

  constructor(options: LogRetentionManagerOptions) {
    this.retentionMs = options.retentionMs;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxTimerDelayMs = options.maxTimerDelayMs ?? DEFAULT_MAX_TIMER_DELAY_MS;
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer =
      options.clearTimer ??
      ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.markAutomaticDelete = options.markAutomaticDelete ?? (() => undefined);
    this.unmarkAutomaticDelete = options.unmarkAutomaticDelete ?? (() => undefined);
    this.isMissingMessageError = options.isMissingMessageError ?? (() => false);
    this.onDeleteError = options.onDeleteError ?? (() => undefined);
  }

  schedule(message: RetentionMessage): void {
    const remainingMs = this.getExpirationTimestamp(message) - this.now();

    if (remainingMs <= 0) {
      void this.deleteNow(message);
      return;
    }

    this.armExpirationTimer(message, remainingMs);
  }

  async deleteNow(message: RetentionMessage): Promise<boolean> {
    this.cancel(message.id);
    this.markAutomaticDelete(message.id);

    try {
      await message.delete();
      return true;
    } catch (error) {
      this.unmarkAutomaticDelete(message.id);

      if (this.isMissingMessageError(error)) {
        return true;
      }

      this.onDeleteError(message.id, error);
      this.armRetryTimer(message);
      return false;
    }
  }

  cancel(messageId: string): void {
    const timer = this.timers.get(messageId);
    if (!timer) return;

    this.clearTimer(timer);
    this.timers.delete(messageId);
  }

  isScheduled(messageId: string): boolean {
    return this.timers.has(messageId);
  }

  private getExpirationTimestamp(message: RetentionMessage): number {
    return message.createdTimestamp + this.retentionMs;
  }

  private armExpirationTimer(message: RetentionMessage, remainingMs: number): void {
    const delayMs = Math.min(Math.max(0, remainingMs), this.maxTimerDelayMs);
    this.armTimer(message, delayMs, () => {
      const nextRemainingMs = this.getExpirationTimestamp(message) - this.now();
      if (nextRemainingMs > 0) {
        this.armExpirationTimer(message, nextRemainingMs);
        return;
      }

      void this.deleteNow(message);
    });
  }

  private armRetryTimer(message: RetentionMessage): void {
    this.armTimer(message, this.retryDelayMs, () => {
      void this.deleteNow(message);
    });
  }

  private armTimer(message: RetentionMessage, delayMs: number, callback: () => void): void {
    this.cancel(message.id);

    const timer = this.setTimer(() => {
      this.timers.delete(message.id);
      callback();
    }, delayMs);

    timer.unref?.();
    this.timers.set(message.id, timer);
  }
}

export interface HistoryMessage {
  id: string;
}

export interface AuthoredHistoryMessage extends HistoryMessage {
  createdTimestamp: number;
  author: { id: string };
}

export function partitionOwnedMessages<T extends AuthoredHistoryMessage>(
  messages: T[],
  botUserId: string,
  now: number,
  retentionMs: number
): { active: T[]; expired: T[] } {
  const owned = messages.filter((message) => message.author.id === botUserId);
  return {
    active: owned.filter((message) => now - message.createdTimestamp < retentionMs),
    expired: owned.filter((message) => now - message.createdTimestamp >= retentionMs),
  };
}
export interface WalkHistoryOptions<T extends HistoryMessage> {
  fetchPage: (before?: string) => Promise<T[]>;
  handlePage: (messages: T[]) => Promise<void>;
  pageSize?: number;
}

export async function walkMessageHistory<T extends HistoryMessage>(
  options: WalkHistoryOptions<T>
): Promise<void> {
  const pageSize = options.pageSize ?? 100;
  let before: string | undefined;

  while (true) {
    const messages = await options.fetchPage(before);
    if (messages.length === 0) return;

    await options.handlePage(messages);

    if (messages.length < pageSize) return;
    before = messages[messages.length - 1]?.id;
    if (!before) return;
  }
}
